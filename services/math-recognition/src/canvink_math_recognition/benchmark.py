"""Content-free benchmark measurements and exact Math Canvas acceptance evidence."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import statistics
import time
from typing import Iterable

from .app import build_application_from_environment
from .contract import MAX_BODY_BYTES, parse_request
from .raster import rasterize


MAX_BENCHMARK_SAMPLES = 10_000
MAX_MEASUREMENT_BYTES = 1024 * 1024
_HARDWARE_LABEL = re.compile(r"^[A-Za-z0-9 ._-]{1,64}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_RUN_KEYS = {
    "schemaVersion", "kind", "contentFree", "gpuClass", "apiVersion",
    "modelArtifactSha256", "corpusSha256", "licenseManifestSha256",
    "writerCount", "sampleCount", "successful", "failed", "medianMs", "p95Ms",
    "basicCorrect", "basicTotal", "totalCorrect", "totalCount",
    "provenanceReviewed", "selfCreatedOrExplicitlyLicensed",
    "restrictedResearchDatasetUsed",
}


def _percentile_nearest_rank(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    rank = max(1, int(len(ordered) * percentile + 0.999999))
    return ordered[min(rank - 1, len(ordered) - 1)]


def _assert_sha256(value: str, label: str) -> str:
    if _SHA256.fullmatch(value) is None:
        raise ValueError(f"invalid {label}")
    return value


def benchmark_requests(
    paths: Iterable[Path],
    *,
    gpu: str,
    writer_count: int,
    rights_basis: str,
    license_manifest_sha256: str,
    model_artifact_sha256: str,
    provenance_reviewed: bool,
    basic_correct: int,
    basic_total: int,
    overall_correct: int,
    overall_total: int,
) -> dict[str, object]:
    """Measure one real GPU run and return a content-free, mergeable record."""
    if _HARDWARE_LABEL.fullmatch(gpu) is None:
        raise ValueError("invalid hardware label")
    if not 1 <= writer_count <= MAX_BENCHMARK_SAMPLES:
        raise ValueError("invalid writer count")
    if rights_basis not in ("self-created", "explicitly-released"):
        raise ValueError("invalid rights basis")
    _assert_sha256(license_manifest_sha256, "license manifest hash")
    _assert_sha256(model_artifact_sha256, "model artifact hash")
    application = build_application_from_environment()
    durations: list[float] = []
    failures = 0
    sample_hashes: list[bytes] = []
    sample_count = 0
    for path in paths:
        sample_count += 1
        if sample_count > MAX_BENCHMARK_SAMPLES:
            raise ValueError("benchmark sample limit exceeded")
        started = time.perf_counter()
        try:
            if path.stat().st_size > MAX_BODY_BYTES:
                raise ValueError
            body = path.read_bytes()
            if len(body) > MAX_BODY_BYTES:
                raise ValueError
            request = parse_request(body)
            sample_hashes.append(hashlib.sha256(body).digest())
            raster = rasterize(request)
            application.adapter.recognize(raster, application.model_timeout_seconds)
            durations.append((time.perf_counter() - started) * 1_000)
        except Exception:
            failures += 1
    if sample_count == 0 or not durations:
        raise ValueError("no successful benchmark samples")
    if writer_count > sample_count:
        raise ValueError("writer count exceeds sample count")
    for correct, total, label in (
        (basic_correct, basic_total, "basic accuracy"),
        (overall_correct, overall_total, "overall accuracy"),
    ):
        if total <= 0 or correct < 0 or correct > total or total > sample_count:
            raise ValueError(f"invalid {label}")
    if overall_total != sample_count or basic_correct > overall_correct:
        raise ValueError("accuracy counts do not bind to the measured corpus")

    corpus_digest = hashlib.sha256(b"".join(sorted(sample_hashes))).hexdigest()
    return {
        "schemaVersion": 1,
        "kind": "canvink-math-benchmark-run",
        "contentFree": True,
        "gpuClass": gpu,
        "apiVersion": "v1",
        "modelArtifactSha256": model_artifact_sha256,
        "corpusSha256": corpus_digest,
        "licenseManifestSha256": license_manifest_sha256,
        "writerCount": writer_count,
        "sampleCount": sample_count,
        "successful": len(durations),
        "failed": failures,
        "medianMs": round(statistics.median(durations), 2),
        "p95Ms": round(_percentile_nearest_rank(durations, 0.95), 2),
        "basicCorrect": basic_correct,
        "basicTotal": basic_total,
        "totalCorrect": overall_correct,
        "totalCount": overall_total,
        "provenanceReviewed": provenance_reviewed,
        "selfCreatedOrExplicitlyLicensed": True,
        "restrictedResearchDatasetUsed": False,
    }


def build_acceptance_evidence(
    runs: Iterable[dict[str, object]],
    *,
    repository_commit: str,
    package_version: str,
    recorded_at: str | None = None,
) -> dict[str, dict[str, object]]:
    """Build the validator's two exact envelopes from two independent GPU runs."""
    if _COMMIT.fullmatch(repository_commit) is None:
        raise ValueError("invalid repository commit")
    if not package_version or len(package_version) > 128:
        raise ValueError("invalid package version")
    validated = [_validate_run(run) for run in runs]
    if len(validated) != 2 or len({str(run["gpuClass"]) for run in validated}) != 2:
        raise ValueError("exactly two unique GPU measurements are required")
    binding_keys = (
        "apiVersion", "modelArtifactSha256", "corpusSha256", "licenseManifestSha256",
        "writerCount", "sampleCount", "basicCorrect", "basicTotal", "totalCorrect",
        "totalCount", "provenanceReviewed", "selfCreatedOrExplicitlyLicensed",
        "restrictedResearchDatasetUsed",
    )
    first = validated[0]
    if any(run[key] != first[key] for run in validated[1:] for key in binding_keys):
        raise ValueError("GPU runs do not describe the same corpus, model, and accuracy review")
    timestamp = recorded_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    basic_percent = round(int(first["basicCorrect"]) * 100 / int(first["basicTotal"]), 2)
    overall_percent = round(int(first["totalCorrect"]) * 100 / int(first["totalCount"]), 2)
    recognition_results = {
        "corpusSha256": first["corpusSha256"],
        "licenseManifestSha256": first["licenseManifestSha256"],
        "sampleCount": first["sampleCount"],
        "writerCount": first["writerCount"],
        "basicCorrect": first["basicCorrect"],
        "basicTotal": first["basicTotal"],
        "totalCorrect": first["totalCorrect"],
        "totalCount": first["totalCount"],
        "basicAccuracyPercent": basic_percent,
        "overallAccuracyPercent": overall_percent,
        "provenanceReviewed": first["provenanceReviewed"],
        "selfCreatedOrExplicitlyLicensed": first["selfCreatedOrExplicitlyLicensed"],
        "restrictedResearchDatasetUsed": first["restrictedResearchDatasetUsed"],
    }
    measurements = [{
        "gpuClass": run["gpuClass"],
        "sampleCount": run["successful"],
        "medianMs": run["medianMs"],
        "p95Ms": run["p95Ms"],
    } for run in sorted(validated, key=lambda item: str(item["gpuClass"]))]
    recognition_passed = (
        int(first["sampleCount"]) >= 300
        and int(first["writerCount"]) >= 5
        and basic_percent >= 90
        and overall_percent >= 80
        and bool(first["provenanceReviewed"])
        and bool(first["selfCreatedOrExplicitlyLicensed"])
        and not bool(first["restrictedResearchDatasetUsed"])
        and all(int(run["failed"]) == 0 for run in validated)
    )
    latency_passed = all(
        int(item["sampleCount"]) > 0
        and float(item["medianMs"]) <= 1500
        and float(item["p95Ms"]) <= 3000
        for item in measurements
    )

    def envelope(kind: str, producer: str, status: bool, results: dict[str, object]) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "kind": kind,
            "contentFree": True,
            "repositoryCommit": repository_commit,
            "packageVersion": package_version,
            "recordedAt": timestamp,
            "status": "passed" if status else "failed",
            "producer": producer,
            "results": results,
        }

    return {
        "recognition-corpus.json": envelope(
            "math-recognition-corpus", "canvink-math-recognition-benchmark-v1",
            recognition_passed, recognition_results,
        ),
        "gpu-latency.json": envelope(
            "math-gpu-latency", "canvink-math-gpu-benchmark-v1", latency_passed,
            {
                "modelArtifactSha256": first["modelArtifactSha256"],
                "apiVersion": first["apiVersion"],
                "measurements": measurements,
                "privateServiceOnly": True,
                "rawContentIncluded": False,
            },
        ),
    }


def _validate_run(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != _RUN_KEYS:
        raise ValueError("invalid benchmark run shape")
    if value["schemaVersion"] != 1 or value["kind"] != "canvink-math-benchmark-run" or value["contentFree"] is not True:
        raise ValueError("invalid benchmark run envelope")
    if _HARDWARE_LABEL.fullmatch(str(value["gpuClass"])) is None:
        raise ValueError("invalid benchmark GPU class")
    for key in ("modelArtifactSha256", "corpusSha256", "licenseManifestSha256"):
        _assert_sha256(str(value[key]), key)
    integer_keys = (
        "writerCount", "sampleCount", "successful", "failed", "basicCorrect",
        "basicTotal", "totalCorrect", "totalCount",
    )
    if any(type(value[key]) is not int or int(value[key]) < 0 for key in integer_keys):
        raise ValueError("invalid benchmark counts")
    if any(type(value[key]) is not bool for key in (
        "provenanceReviewed", "selfCreatedOrExplicitlyLicensed", "restrictedResearchDatasetUsed",
    )):
        raise ValueError("invalid benchmark provenance")
    if not all(isinstance(value[key], (int, float)) and not isinstance(value[key], bool) and float(value[key]) >= 0 for key in ("medianMs", "p95Ms")):
        raise ValueError("invalid benchmark timings")
    if int(value["successful"]) + int(value["failed"]) != int(value["sampleCount"]):
        raise ValueError("benchmark counts do not reconcile")
    return dict(value)


def _read_measurement(path: Path) -> dict[str, object]:
    if path.stat().st_size > MAX_MEASUREMENT_BYTES:
        raise ValueError("measurement is too large")
    return _validate_run(json.loads(path.read_text(encoding="utf-8")))


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run or combine private content-free recognition benchmarks")
    parser.add_argument("corpus", nargs="?", type=Path)
    parser.add_argument("--gpu")
    parser.add_argument("--writer-count", type=int)
    parser.add_argument("--rights-basis", choices=("self-created", "explicitly-released"))
    parser.add_argument("--license-manifest-sha256")
    parser.add_argument("--model-artifact-sha256")
    parser.add_argument("--provenance-reviewed", action="store_true")
    parser.add_argument("--basic-correct", type=int)
    parser.add_argument("--basic-total", type=int)
    parser.add_argument("--overall-correct", type=int)
    parser.add_argument("--overall-total", type=int)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--acceptance-measurements", nargs=2, type=Path)
    parser.add_argument("--repository-commit")
    parser.add_argument("--package-version")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    try:
        if args.acceptance_measurements:
            if not args.repository_commit or not args.package_version or not args.output_dir:
                raise ValueError
            evidence = build_acceptance_evidence(
                [_read_measurement(path) for path in args.acceptance_measurements],
                repository_commit=args.repository_commit,
                package_version=args.package_version,
            )
            for name, value in evidence.items():
                _write_json(args.output_dir / name, value)
            return
        required = (
            args.corpus, args.gpu, args.writer_count, args.rights_basis,
            args.license_manifest_sha256, args.model_artifact_sha256,
            args.basic_correct, args.basic_total, args.overall_correct,
            args.overall_total, args.output,
        )
        if any(value is None for value in required) or not args.corpus.is_dir():
            raise ValueError
        run = benchmark_requests(
            sorted(args.corpus.glob("*.json")), gpu=args.gpu,
            writer_count=args.writer_count, rights_basis=args.rights_basis,
            license_manifest_sha256=args.license_manifest_sha256,
            model_artifact_sha256=args.model_artifact_sha256,
            provenance_reviewed=args.provenance_reviewed,
            basic_correct=args.basic_correct, basic_total=args.basic_total,
            overall_correct=args.overall_correct, overall_total=args.overall_total,
        )
        _write_json(args.output, run)
    except Exception:
        raise SystemExit("benchmark failed") from None


if __name__ == "__main__":
    main()
