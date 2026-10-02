from __future__ import annotations

from http.client import HTTPConnection
import io
import json
import logging
import threading
import unittest

from canvink_math_recognition.adapters import FakeModelAdapter
from canvink_math_recognition.app import RecognitionApplication, _RecognitionHTTPServer
from canvink_math_recognition.contract import MAX_BODY_BYTES

from .helpers import TOKEN, headers, request_body


class ApplicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.application = RecognitionApplication(TOKEN, FakeModelAdapter("sensitive_formula"))

    def test_auth_content_type_and_method_are_enforced(self) -> None:
        self.assertEqual(
            self.application.dispatch(
                "POST", "/v1/math/recognize", {"content-type": "application/json"}, request_body()
            ).status,
            401,
        )
        self.assertEqual(
            self.application.dispatch(
                "POST",
                "/v1/math/recognize",
                headers("wrong-token-that-is-also-at-least-thirty-two-bytes"),
                request_body(),
            ).status,
            401,
        )
        wrong_media = headers()
        wrong_media["content-type"] = "text/plain"
        self.assertEqual(
            self.application.dispatch("POST", "/v1/math/recognize", wrong_media, request_body()).status,
            415,
        )
        self.assertEqual(self.application.dispatch("GET", "/v1/math/recognize", headers()).status, 405)

    def test_fake_model_response_matches_compatible_contract(self) -> None:
        response = self.application.dispatch("POST", "/v1/math/recognize", headers(), request_body())
        self.assertEqual(response.status, 200)
        payload = json.loads(response.body)
        self.assertEqual(
            set(payload),
            {"latex", "candidates", "modelVersion", "apiVersion", "processingDurationMs", "warnings"},
        )
        self.assertEqual(payload["latex"], "sensitive_formula")
        self.assertEqual(payload["apiVersion"], "v1")

    def test_health_has_no_secret_or_endpoint_configuration(self) -> None:
        response = self.application.dispatch("GET", "/healthz", {})
        self.assertEqual(response.status, 200)
        decoded = response.body.decode("utf-8")
        self.assertNotIn(TOKEN, decoded)
        self.assertNotIn("endpoint", decoded.lower())
        self.assertEqual(set(json.loads(decoded)), {"status", "apiVersion", "adapter", "modelVersion"})

    def test_logs_never_contain_token_request_id_or_formula_content(self) -> None:
        stream = io.StringIO()
        logger = logging.Logger("test-content-free")
        logger.addHandler(logging.StreamHandler(stream))
        application = RecognitionApplication(TOKEN, FakeModelAdapter("sensitive_formula"), logger=logger)
        application.dispatch("POST", "/v1/math/recognize", headers(), request_body())
        log = stream.getvalue()
        self.assertIn("event=recognized", log)
        for secret in (TOKEN, "request_1234567890", "sensitive_formula", "0.1", "de-CH"):
            self.assertNotIn(secret, log)


class HTTPBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = _RecognitionHTTPServer(("127.0.0.1", 0), RecognitionApplication(TOKEN, FakeModelAdapter()))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, method: str, path: str, body: bytes | None = None, request_headers: dict[str, str] | None = None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.request(method, path, body=body, headers=request_headers or {})
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, dict(response.getheaders()), payload

    def test_real_http_success_and_security_headers(self) -> None:
        status, response_headers, body = self.request(
            "POST",
            "/v1/math/recognize",
            request_body(),
            {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(response_headers["Cache-Control"], "no-store")
        self.assertEqual(response_headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(json.loads(body)["latex"], "x+1")

    def test_oversize_content_length_rejected_without_body(self) -> None:
        connection = HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.putrequest("POST", "/v1/math/recognize")
        connection.putheader("Authorization", f"Bearer {TOKEN}")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(MAX_BODY_BYTES + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()

    def test_duplicate_authorization_and_chunked_requests_are_rejected(self) -> None:
        connection = HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.putrequest("POST", "/v1/math/recognize")
        connection.putheader("Authorization", f"Bearer {TOKEN}")
        connection.putheader("Authorization", f"Bearer {TOKEN}")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", "0")
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 401)
        response.read()
        connection.close()

        status, _, _ = self.request(
            "POST",
            "/v1/math/recognize",
            b"0",
            {
                "Authorization": f"Bearer {TOKEN}",
                "Content-Type": "application/json",
                "Transfer-Encoding": "chunked",
            },
        )
        self.assertEqual(status, 400)

    def test_duplicate_content_type_is_rejected(self) -> None:
        connection = HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.putrequest("POST", "/v1/math/recognize")
        connection.putheader("Authorization", f"Bearer {TOKEN}")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Type", "text/plain")
        connection.putheader("Content-Length", "0")
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 415)
        response.read()
        connection.close()


if __name__ == "__main__":
    unittest.main()
