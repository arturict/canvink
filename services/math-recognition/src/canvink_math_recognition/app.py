"""HTTP application for the private Canvink math-recognition contract."""

from __future__ import annotations

from dataclasses import dataclass
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import socket
import threading
import time
from typing import Mapping

from .adapters import (
    FakeModelAdapter,
    MAX_MODEL_TIMEOUT_SECONDS,
    ModelAdapter,
    ModelTimeoutError,
    ModelUnavailableError,
    TexTellerAdapter,
    UniMERNetBenchmarkAdapter,
)
from .contract import API_VERSION, ContractError, MAX_BODY_BYTES, parse_request, response_document
from .raster import RasterLimitError, rasterize


MAX_TOKEN_BYTES = 4_096
MIN_TOKEN_BYTES = 32
BODY_READ_TIMEOUT_SECONDS = 5.0
MODEL_QUEUE_TIMEOUT_SECONDS = 0.1


@dataclass(frozen=True, slots=True)
class Response:
    status: int
    body: bytes


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def _error(status: int, code: str) -> Response:
    messages = {
        "unauthorized": "Authentication is required.",
        "not-found": "The requested endpoint does not exist.",
        "method-not-allowed": "The HTTP method is not allowed.",
        "unsupported-media-type": "Content-Type must be application/json.",
        "invalid-input": "The recognition request is invalid.",
        "payload-too-large": "The recognition request exceeds a configured limit.",
        "request-timeout": "The recognition request timed out.",
        "provider-busy": "The recognition provider is busy.",
        "provider-timeout": "The recognition provider timed out.",
        "provider-unavailable": "The recognition provider is unavailable.",
        "invalid-model-output": "The recognition provider returned an invalid response.",
    }
    return Response(status, _json_bytes({"error": {"code": code, "message": messages[code]}}))


class RecognitionApplication:
    def __init__(
        self,
        bearer_token: str,
        adapter: ModelAdapter,
        *,
        model_timeout_seconds: float = MAX_MODEL_TIMEOUT_SECONDS,
        max_parallel_models: int = 1,
        logger: logging.Logger | None = None,
    ) -> None:
        encoded = bearer_token.encode("utf-8")
        if not MIN_TOKEN_BYTES <= len(encoded) <= MAX_TOKEN_BYTES or any(byte < 33 or byte > 126 for byte in encoded):
            raise ValueError("invalid bearer token configuration")
        if not 0.0 < model_timeout_seconds <= MAX_MODEL_TIMEOUT_SECONDS:
            raise ValueError("invalid model timeout configuration")
        if not 1 <= max_parallel_models <= 8:
            raise ValueError("invalid model concurrency configuration")
        self._token = encoded
        self.adapter = adapter
        self.model_timeout_seconds = model_timeout_seconds
        self._model_slots = threading.BoundedSemaphore(max_parallel_models)
        self._logger = logger or logging.getLogger("canvink.math_recognition")

    def _authorized(self, authorization: str | None) -> bool:
        if authorization is None or not authorization.startswith("Bearer "):
            return False
        candidate = authorization[7:].encode("utf-8")
        if len(candidate) > MAX_TOKEN_BYTES:
            return False
        return hmac.compare_digest(candidate, self._token)

    @staticmethod
    def _media_type(content_type: str | None) -> bool:
        if content_type is None:
            return False
        parts = [part.strip().lower() for part in content_type.split(";")]
        if parts[0] != "application/json":
            return False
        return all(part == "charset=utf-8" for part in parts[1:] if part)

    def dispatch(self, method: str, path: str, headers: Mapping[str, str], body: bytes = b"") -> Response:
        started = time.monotonic()
        status = 500
        event = "rejected"
        try:
            if method == "GET" and path == "/healthz":
                status = 200
                event = "health"
                return Response(
                    status,
                    _json_bytes(
                        {
                            "status": "ready",
                            "apiVersion": API_VERSION,
                            "adapter": self.adapter.kind,
                            "modelVersion": self.adapter.model_version,
                        }
                    ),
                )
            if path != "/v1/math/recognize":
                status = 404
                return _error(status, "not-found")
            if method != "POST":
                status = 405
                return _error(status, "method-not-allowed")
            if not self._authorized(headers.get("authorization")):
                status = 401
                return _error(status, "unauthorized")
            if not self._media_type(headers.get("content-type")):
                status = 415
                return _error(status, "unsupported-media-type")
            if len(body) > MAX_BODY_BYTES:
                status = 413
                return _error(status, "payload-too-large")
            request = parse_request(body)
            try:
                image = rasterize(request)
            except RasterLimitError:
                status = 413
                return _error(status, "payload-too-large")
            if not self._model_slots.acquire(timeout=MODEL_QUEUE_TIMEOUT_SECONDS):
                status = 503
                return _error(status, "provider-busy")
            try:
                result = self.adapter.recognize(image, self.model_timeout_seconds)
            finally:
                self._model_slots.release()
            duration_ms = round((time.monotonic() - started) * 1_000)
            encoded = response_document(result, duration_ms)
            status = 200
            event = "recognized"
            return Response(status, encoded)
        except ContractError as error:
            status = error.status
            return _error(status, error.code)
        except ModelTimeoutError:
            status = 504
            return _error(status, "provider-timeout")
        except ModelUnavailableError:
            status = 503
            return _error(status, "provider-unavailable")
        except Exception:
            status = 503
            return _error(status, "provider-unavailable")
        finally:
            duration_ms = min(120_000, round((time.monotonic() - started) * 1_000))
            self._logger.info("event=%s status=%d duration_ms=%d", event, status, duration_ms)


class _RecognitionHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 32

    def __init__(self, address: tuple[str, int], application: RecognitionApplication) -> None:
        self.application = application
        super().__init__(address, _RecognitionHandler)

    def handle_error(self, _request: object, _client_address: object) -> None:
        logging.getLogger("canvink.math_recognition").error("event=transport_error")


class _RecognitionHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CanvinkMath"
    sys_version = ""

    @property
    def application(self) -> RecognitionApplication:
        server = self.server
        assert isinstance(server, _RecognitionHTTPServer)
        return server.application

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(BODY_READ_TIMEOUT_SECONDS)

    def log_message(self, _format: str, *args: object) -> None:
        return

    def _send(self, response: Response) -> None:
        self.send_response(response.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response.body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(response.body)
        self.close_connection = True

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._send(self.application.dispatch("GET", self.path, self._headers()))

    def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._send(self.application.dispatch("HEAD", self.path, self._headers()))

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        headers = self._headers()
        if self.path != "/v1/math/recognize":
            self._send(self.application.dispatch("POST", self.path, headers))
            return
        authorization_values = self.headers.get_all("Authorization", [])
        if len(authorization_values) != 1:
            self._send(_error(401, "unauthorized"))
            return
        headers["authorization"] = authorization_values[0]
        content_types = self.headers.get_all("Content-Type", [])
        if len(content_types) != 1:
            self._send(_error(415, "unsupported-media-type"))
            return
        headers["content-type"] = content_types[0]
        if self.headers.get("Transfer-Encoding") is not None:
            self._send(_error(400, "invalid-input"))
            return
        content_lengths = self.headers.get_all("Content-Length", [])
        if len(content_lengths) != 1 or not content_lengths[0].isdigit() or len(content_lengths[0]) > 10:
            self._send(_error(400, "invalid-input"))
            return
        length = int(content_lengths[0])
        if length > MAX_BODY_BYTES:
            self._send(_error(413, "payload-too-large"))
            return
        try:
            body = self.rfile.read(length)
        except (TimeoutError, socket.timeout, OSError):
            self._send(_error(408, "request-timeout"))
            return
        if len(body) != length:
            self._send(_error(400, "invalid-input"))
            return
        self._send(self.application.dispatch("POST", self.path, headers, body))

    def _headers(self) -> dict[str, str]:
        return {key.lower(): value for key, value in self.headers.items()}


def build_application_from_environment(environment: Mapping[str, str] | None = None) -> RecognitionApplication:
    values = os.environ if environment is None else environment
    token = values.get("CANVINK_MATH_BEARER_TOKEN", "")
    adapter_kind = values.get("CANVINK_MATH_MODEL_ADAPTER", "texteller")
    if adapter_kind == "fake":
        if values.get("CANVINK_MATH_ALLOW_FAKE_MODEL") != "1":
            raise ValueError("fake adapter is test-only")
        adapter: ModelAdapter = FakeModelAdapter(values.get("CANVINK_MATH_FAKE_LATEX", "x+1"))
    elif adapter_kind == "texteller":
        install = values.get("CANVINK_TEXTELLER_INSTALL_DIR")
        if not install:
            raise ValueError("TexTeller install path is required")
        python_value = values.get("CANVINK_TEXTELLER_PYTHON")
        adapter = TexTellerAdapter(
            Path(install),
            python_executable=Path(python_value) if python_value else None,
            configured_model_version=values.get("CANVINK_TEXTELLER_MODEL_VERSION", "texteller-local-unverified"),
        )
    elif adapter_kind == "unimernet-benchmark":
        install = values.get("CANVINK_UNIMERNET_INSTALL_DIR")
        if not install:
            raise ValueError("UniMERNet install path is required")
        python_value = values.get("CANVINK_UNIMERNET_PYTHON")
        adapter = UniMERNetBenchmarkAdapter(
            Path(install),
            python_executable=Path(python_value) if python_value else None,
            configured_model_version=values.get(
                "CANVINK_UNIMERNET_MODEL_VERSION", "unimernet-local-unverified"
            ),
        )
    else:
        raise ValueError("unknown adapter")
    timeout = float(values.get("CANVINK_MATH_MODEL_TIMEOUT_SECONDS", "15"))
    concurrency = int(values.get("CANVINK_MATH_MAX_PARALLEL_MODELS", "1"))
    return RecognitionApplication(token, adapter, model_timeout_seconds=timeout, max_parallel_models=concurrency)


def serve(application: RecognitionApplication, host: str = "127.0.0.1", port: int = 8787) -> None:
    server = _RecognitionHTTPServer((host, port), application)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
