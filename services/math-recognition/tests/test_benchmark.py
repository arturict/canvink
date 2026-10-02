from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from canvink_math_recognition.benchmark import benchmark_requests, build_acceptance_evidence

from .helpers import TOKEN, request_body


class BenchmarkTests(unittest.TestCase):
    def test_generates_exact_content_free_validator_envelopes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sample = Path(directory) / "private-formula.json"
            sample.write_bytes(request_body())
            samples = [sample] * 300
            environment = {
                "CANVINK_MATH_BEARER_TOKEN": TOKEN,
                "CANVINK_MATH_MODEL_ADAPTER": "fake",
                "CANVINK_MATH_ALLOW_FAKE_MODEL": "1",
                "CANVINK_MATH_FAKE_LATEX": "private_formula_result",
            }
            with patch.dict(os.environ, environment, clear=True):
                first = self._run(samples, "RTX-2070")
                second = self._run(samples, "RTX-5060")
            evidence = build_acceptance_evidence(
                [first, second],
                repository_commit="a" * 40,
                package_version="0.2.0-beta.1",
                recorded_at="2026-08-03T12:00:00Z",
            )

        self.assertEqual(set(evidence), {"recognition-corpus.json", "gpu-latency.json"})
        common = {
            "schemaVersion", "kind", "contentFree", "repositoryCommit",
            "packageVersion", "recordedAt", "status", "producer", "results",
        }
        for artifact in evidence.values():
            self.assertEqual(set(artifact), common)
            self.assertEqual(artifact["repositoryCommit"], "a" * 40)
            self.assertEqual(artifact["packageVersion"], "0.2.0-beta.1")
            self.assertEqual(artifact["status"], "passed")
        recognition = evidence["recognition-corpus.json"]["results"]
        self.assertEqual(set(recognition), {
            "corpusSha256", "licenseManifestSha256", "sampleCount", "writerCount",
            "basicCorrect", "basicTotal", "totalCorrect", "totalCount",
            "basicAccuracyPercent", "overallAccuracyPercent", "provenanceReviewed",
            "selfCreatedOrExplicitlyLicensed", "restrictedResearchDatasetUsed",
        })
        latency = evidence["gpu-latency.json"]["results"]
        self.assertEqual(set(latency), {
            "modelArtifactSha256", "apiVersion", "measurements",
            "privateServiceOnly", "rawContentIncluded",
        })
        self.assertEqual([item["gpuClass"] for item in latency["measurements"]], ["RTX-2070", "RTX-5060"])
        encoded = json.dumps(evidence)
        for forbidden in (
            "private-formula.json", "private_formula_result", "request_1234567890",
            "de-CH", TOKEN, str(Path(directory)),
        ):
            self.assertNotIn(forbidden, encoded)

    def test_marks_below_threshold_evidence_failed_instead_of_claiming_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sample = Path(directory) / "sample.json"
            sample.write_bytes(request_body())
            environment = {
                "CANVINK_MATH_BEARER_TOKEN": TOKEN,
                "CANVINK_MATH_MODEL_ADAPTER": "fake",
                "CANVINK_MATH_ALLOW_FAKE_MODEL": "1",
            }
            with patch.dict(os.environ, environment, clear=True):
                first = self._run([sample] * 300, "GPU-A", basic_correct=89, overall_correct=239)
                second = self._run([sample] * 300, "GPU-B", basic_correct=89, overall_correct=239)
        evidence = build_acceptance_evidence(
            [first, second], repository_commit="b" * 40, package_version="0.2.0",
        )
        self.assertEqual(evidence["recognition-corpus.json"]["status"], "failed")

    @staticmethod
    def _run(
        samples: list[Path],
        gpu: str,
        *,
        basic_correct: int = 90,
        overall_correct: int = 240,
    ) -> dict[str, object]:
        return benchmark_requests(
            samples,
            gpu=gpu,
            writer_count=5,
            rights_basis="self-created",
            license_manifest_sha256="b" * 64,
            model_artifact_sha256="c" * 64,
            provenance_reviewed=True,
            basic_correct=basic_correct,
            basic_total=100,
            overall_correct=overall_correct,
            overall_total=300,
        )


if __name__ == "__main__":
    unittest.main()
