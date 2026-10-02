"""Replaceable model adapters. No adapter downloads models."""

from __future__ import annotations

from abc import ABC, abstractmethod
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from typing import Any

from .contract import Candidate, ContractError, ModelResult, validate_model_result
from .raster import Raster


MAX_MODEL_OUTPUT_BYTES = 256 * 1024
MAX_MODEL_TIMEOUT_SECONDS = 15.0


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


class ModelUnavailableError(RuntimeError):
    pass


class ModelTimeoutError(RuntimeError):
    pass


class ModelAdapter(ABC):
    kind: str

    @property
    @abstractmethod
    def model_version(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def recognize(self, raster: Raster, timeout_seconds: float) -> ModelResult:
        raise NotImplementedError


class FakeModelAdapter(ModelAdapter):
    """Deterministic adapter for tests and local contract checks only."""

    kind = "fake"

    def __init__(self, latex: str = "x+1", model_version: str = "fake-1") -> None:
        self._result = validate_model_result(ModelResult(latex=latex, model_version=model_version))

    @property
    def model_version(self) -> str:
        return self._result.model_version or "fake-1"

    def recognize(self, raster: Raster, timeout_seconds: float) -> ModelResult:
        if not raster.grayscale or timeout_seconds <= 0:
            raise ModelUnavailableError
        return self._result


class _LocalRunnerAdapter(ModelAdapter):
    """Runs an operator-supplied model wrapper from a local install tree.

    The wrapper receives a PGM image on stdin and must emit one bounded JSON
    object on stdout. This service never installs or downloads TexTeller or a
    model and launches the wrapper with common model-hub download flags disabled.
    """

    def __init__(
        self,
        install_dir: Path,
        *,
        runner_name: str,
        python_executable: Path | None = None,
        configured_model_version: str,
    ) -> None:
        try:
            root = install_dir.expanduser().resolve(strict=True)
        except OSError as error:
            raise ModelUnavailableError from error
        if not root.is_dir():
            raise ModelUnavailableError
        try:
            runner = (root / runner_name).resolve(strict=True)
        except OSError as error:
            raise ModelUnavailableError from error
        if runner.parent != root or not runner.is_file() or runner.suffix != ".py":
            raise ModelUnavailableError
        try:
            executable = (python_executable or Path(sys.executable)).expanduser().resolve(strict=True)
        except OSError as error:
            raise ModelUnavailableError from error
        if python_executable is not None and root not in executable.parents:
            raise ModelUnavailableError
        self._root = root
        self._runner = runner
        self._python = executable
        checked_version = validate_model_result(
            ModelResult(latex="configuration-check", model_version=configured_model_version)
        ).model_version
        assert checked_version is not None
        self._model_version = checked_version

    @property
    def model_version(self) -> str:
        return self._model_version

    @staticmethod
    def _environment() -> dict[str, str]:
        allowed = ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "CUDA_VISIBLE_DEVICES")
        environment = {key: os.environ[key] for key in allowed if key in os.environ}
        environment.update(
            {
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "HF_DATASETS_OFFLINE": "1",
                "TOKENIZERS_PARALLELISM": "false",
            }
        )
        return environment

    def recognize(self, raster: Raster, timeout_seconds: float) -> ModelResult:
        timeout = min(max(timeout_seconds, 0.01), MAX_MODEL_TIMEOUT_SECONDS)
        try:
            process = subprocess.Popen(
                [str(self._python), "-I", str(self._runner)],
                cwd=str(self._root),
                env=self._environment(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError as error:
            raise ModelUnavailableError from error

        output = bytearray()
        exceeded = threading.Event()
        writer_failed = threading.Event()

        def read_stdout() -> None:
            assert process.stdout is not None
            while True:
                chunk = process.stdout.read(16 * 1024)
                if not chunk:
                    return
                if len(output) + len(chunk) > MAX_MODEL_OUTPUT_BYTES:
                    exceeded.set()
                    process.kill()
                    return
                output.extend(chunk)

        def write_stdin() -> None:
            assert process.stdin is not None
            try:
                process.stdin.write(raster.to_pgm())
                process.stdin.flush()
            except OSError:
                writer_failed.set()
            finally:
                process.stdin.close()

        reader = threading.Thread(target=read_stdout, daemon=True)
        writer = threading.Thread(target=write_stdin, daemon=True)
        reader.start()
        writer.start()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            writer.join(timeout=1)
            reader.join(timeout=1)
            if process.stdout is not None:
                process.stdout.close()
            raise ModelTimeoutError from None
        writer.join(timeout=1)
        reader.join(timeout=1)
        if process.stdout is not None:
            process.stdout.close()
        if (
            writer.is_alive()
            or reader.is_alive()
            or writer_failed.is_set()
            or exceeded.is_set()
            or process.returncode != 0
        ):
            process.kill()
            raise ModelUnavailableError

        try:
            raw: Any = json.loads(
                bytes(output).decode("utf-8"), object_pairs_hook=_unique_json_object
            )
            if not isinstance(raw, dict) or not set(raw).issubset(
                {"latex", "candidates", "modelVersion", "warnings"}
            ) or "latex" not in raw:
                raise ValueError
            candidates_raw = raw.get("candidates", [])
            warnings_raw = raw.get("warnings", [])
            if not isinstance(candidates_raw, list) or not isinstance(warnings_raw, list):
                raise ValueError
            candidates = tuple(
                Candidate(item["latex"], item.get("confidence"))
                for item in candidates_raw
                if isinstance(item, dict) and set(item).issubset({"latex", "confidence"}) and "latex" in item
            )
            if len(candidates) != len(candidates_raw) or not all(isinstance(item, str) for item in warnings_raw):
                raise ValueError
            result = ModelResult(
                latex=raw["latex"],
                candidates=candidates,
                model_version=raw.get("modelVersion", self._model_version),
                warnings=tuple(warnings_raw),
            )
            return validate_model_result(result)
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError, ContractError):
            raise ModelUnavailableError from None


class TexTellerAdapter(_LocalRunnerAdapter):
    """Optional private TexTeller experiment adapter; never downloads a model."""

    kind = "texteller"

    def __init__(
        self,
        install_dir: Path,
        *,
        runner_name: str = "canvink_texteller_runner.py",
        python_executable: Path | None = None,
        configured_model_version: str = "texteller-local-unverified",
    ) -> None:
        super().__init__(
            install_dir,
            runner_name=runner_name,
            python_executable=python_executable,
            configured_model_version=configured_model_version,
        )


class UniMERNetBenchmarkAdapter(_LocalRunnerAdapter):
    """Optional private benchmark alternative, not a product provider/default."""

    kind = "unimernet-benchmark"

    def __init__(
        self,
        install_dir: Path,
        *,
        runner_name: str = "canvink_unimernet_runner.py",
        python_executable: Path | None = None,
        configured_model_version: str = "unimernet-local-unverified",
    ) -> None:
        super().__init__(
            install_dir,
            runner_name=runner_name,
            python_executable=python_executable,
            configured_model_version=configured_model_version,
        )
