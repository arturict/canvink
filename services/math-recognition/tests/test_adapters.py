from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest

from canvink_math_recognition.adapters import (
    ModelTimeoutError,
    ModelUnavailableError,
    TexTellerAdapter,
    UniMERNetBenchmarkAdapter,
)
from canvink_math_recognition.contract import ContractError, parse_request
from canvink_math_recognition.raster import rasterize

from .helpers import request_body


class TexTellerAdapterTests(unittest.TestCase):
    def raster(self):
        return rasterize(parse_request(request_body()))

    def write_runner(self, root: Path, source: str) -> None:
        (root / "canvink_texteller_runner.py").write_text(textwrap.dedent(source), encoding="utf-8")

    def test_local_runner_gets_pgm_offline_flags_and_no_service_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_runner(
                root,
                """
                import json, os, sys
                image = sys.stdin.buffer.read()
                ok = image.startswith(b"P5\\n") and os.environ.get("HF_HUB_OFFLINE") == "1"
                leaked = "CANVINK_MATH_BEARER_TOKEN" in os.environ
                print(json.dumps({"latex": "x^2", "modelVersion": f"runner-{ok}-{leaked}"}))
                """,
            )
            old = os.environ.get("CANVINK_MATH_BEARER_TOKEN")
            os.environ["CANVINK_MATH_BEARER_TOKEN"] = "must-not-reach-runner"
            try:
                result = TexTellerAdapter(root).recognize(self.raster(), 2)
            finally:
                if old is None:
                    os.environ.pop("CANVINK_MATH_BEARER_TOKEN", None)
                else:
                    os.environ["CANVINK_MATH_BEARER_TOKEN"] = old
            self.assertEqual(result.latex, "x^2")
            self.assertEqual(result.model_version, "runner-True-False")

    def test_timeout_malformed_and_oversize_output_fail_closed(self) -> None:
        cases = {
            "timeout": ("import time\ntime.sleep(1)\n", ModelTimeoutError),
            "malformed": ("print('not-json')\n", ModelUnavailableError),
            "duplicate": (
                "print('{\"latex\":\"x\",\"latex\":\"y\"}')\n",
                ModelUnavailableError,
            ),
            "oversize": ("print('x' * (300 * 1024))\n", ModelUnavailableError),
        }
        for name, (source, expected) in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.write_runner(root, source)
                with self.assertRaises(expected):
                    TexTellerAdapter(root).recognize(self.raster(), 0.05 if name == "timeout" else 2)

    def test_runner_and_explicit_python_must_be_inside_trusted_install_tree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_runner(root, "print('{}')")
            with self.assertRaises(ModelUnavailableError):
                TexTellerAdapter(root, runner_name="../outside.py")
            with self.assertRaises(ModelUnavailableError):
                TexTellerAdapter(root, python_executable=Path(sys.executable))
            with self.assertRaises(ContractError):
                TexTellerAdapter(root, configured_model_version="secret\nheader")

    def test_unimernet_uses_same_isolated_protocol_as_benchmark_only_adapter(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "canvink_unimernet_runner.py").write_text(
                "import json, sys\n"
                "sys.stdin.buffer.read()\n"
                "print(json.dumps({'latex':'u+1','modelVersion':'unimernet-fake'}))\n",
                encoding="utf-8",
            )
            adapter = UniMERNetBenchmarkAdapter(root)
            result = adapter.recognize(self.raster(), 2)
            self.assertEqual(adapter.kind, "unimernet-benchmark")
            self.assertEqual(result.latex, "u+1")
            self.assertEqual(result.model_version, "unimernet-fake")


if __name__ == "__main__":
    unittest.main()
