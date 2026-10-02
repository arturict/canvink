"""Strict wire contract for ``POST /v1/math/recognize``.

The contract deliberately has no page, notebook, PDF, image, or absolute-position
field. Unknown fields are rejected so callers cannot accidentally broaden the
privacy boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import re
from typing import Any


PROTOCOL_VERSION = 1
API_VERSION = "v1"
MAX_BODY_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
MAX_STROKES = 256
MAX_POINTS_PER_STROKE = 4_096
MAX_TOTAL_POINTS = 16_384
MAX_BOUND = 8_192.0
MAX_LATEX_BYTES = 64 * 1024
MAX_CANDIDATES = 5
MAX_WARNINGS = 32
MAX_SHORT_TEXT_BYTES = 128
MAX_REQUEST_ID_BYTES = 128

_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_LOCALE = re.compile(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$")


class ContractError(ValueError):
    """A content-free validation error safe to translate to an API response."""

    def __init__(self, code: str = "invalid-input", status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class DuplicateKeyError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Point:
    x: float
    y: float
    pressure: float | None


@dataclass(frozen=True, slots=True)
class Stroke:
    points: tuple[Point, ...]


@dataclass(frozen=True, slots=True)
class BoundingBox:
    width: float
    height: float


@dataclass(frozen=True, slots=True)
class Settings:
    angle_mode: str
    decimal_separator: str


@dataclass(frozen=True, slots=True)
class RecognitionRequest:
    request_id: str
    strokes: tuple[Stroke, ...]
    bounding_box: BoundingBox
    locale: str
    settings: Settings


@dataclass(frozen=True, slots=True)
class Candidate:
    latex: str
    confidence: float | None = None


@dataclass(frozen=True, slots=True)
class ModelResult:
    latex: str
    candidates: tuple[Candidate, ...] = ()
    model_version: str | None = None
    warnings: tuple[str, ...] = ()


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError
        result[key] = value
    return result


def _exact_keys(value: Any, required: set[str], optional: set[str] | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError
    optional = optional or set()
    keys = set(value)
    if not required.issubset(keys) or not keys.issubset(required | optional):
        raise ContractError
    return value


def _finite_number(value: Any, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractError
    result = float(value)
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise ContractError
    return result


def _bounded_text(value: Any, maximum: int, *, allow_newlines: bool = False) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > maximum:
        raise ContractError
    for character in value:
        if not character.isprintable() and not (allow_newlines and character in "\r\n\t"):
            raise ContractError
    return value


def parse_request(body: bytes) -> RecognitionRequest:
    if not body or len(body) > MAX_BODY_BYTES:
        raise ContractError("payload-too-large" if body else "invalid-input", 413 if body else 400)
    try:
        raw = json.loads(body.decode("utf-8"), object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ContractError from None

    top = _exact_keys(
        raw,
        {"protocolVersion", "requestId", "strokes", "boundingBox", "locale", "settings"},
    )
    if type(top["protocolVersion"]) is not int or top["protocolVersion"] != PROTOCOL_VERSION:
        raise ContractError
    request_id = _bounded_text(top["requestId"], MAX_REQUEST_ID_BYTES)
    if _SAFE_IDENTIFIER.fullmatch(request_id) is None:
        raise ContractError
    locale = _bounded_text(top["locale"], 35)
    if _LOCALE.fullmatch(locale) is None:
        raise ContractError

    box_raw = _exact_keys(top["boundingBox"], {"x", "y", "width", "height"})
    if _finite_number(box_raw["x"], 0.0, 0.0) != 0.0 or _finite_number(box_raw["y"], 0.0, 0.0) != 0.0:
        raise ContractError
    width = _finite_number(box_raw["width"], 0.0, MAX_BOUND)
    height = _finite_number(box_raw["height"], 0.0, MAX_BOUND)
    if width == 0.0 or height == 0.0:
        raise ContractError

    settings_raw = _exact_keys(top["settings"], {"angleMode", "decimalSeparator"})
    angle_mode = settings_raw["angleMode"]
    decimal_separator = settings_raw["decimalSeparator"]
    if angle_mode not in ("degree", "radian") or decimal_separator not in ("dot", "comma"):
        raise ContractError

    strokes_raw = top["strokes"]
    if not isinstance(strokes_raw, list) or not strokes_raw:
        raise ContractError
    if len(strokes_raw) > MAX_STROKES:
        raise ContractError("payload-too-large", 413)
    strokes: list[Stroke] = []
    total_points = 0
    for stroke_raw in strokes_raw:
        stroke_object = _exact_keys(stroke_raw, {"points"})
        points_raw = stroke_object["points"]
        if not isinstance(points_raw, list) or not points_raw:
            raise ContractError
        if len(points_raw) > MAX_POINTS_PER_STROKE:
            raise ContractError("payload-too-large", 413)
        total_points += len(points_raw)
        if total_points > MAX_TOTAL_POINTS:
            raise ContractError("payload-too-large", 413)
        points: list[Point] = []
        for point_raw in points_raw:
            point_object = _exact_keys(point_raw, {"x", "y"}, {"pressure"})
            pressure = point_object.get("pressure")
            points.append(
                Point(
                    x=_finite_number(point_object["x"], 0.0, 1.0),
                    y=_finite_number(point_object["y"], 0.0, 1.0),
                    pressure=None if pressure is None else _finite_number(pressure, 0.0, 1.0),
                )
            )
        strokes.append(Stroke(tuple(points)))

    return RecognitionRequest(
        request_id=request_id,
        strokes=tuple(strokes),
        bounding_box=BoundingBox(width, height),
        locale=locale,
        settings=Settings(angle_mode, decimal_separator),
    )


def validate_model_result(result: ModelResult) -> ModelResult:
    latex = _bounded_text(result.latex, MAX_LATEX_BYTES, allow_newlines=True)
    if len(result.candidates) > MAX_CANDIDATES or len(result.warnings) > MAX_WARNINGS:
        raise ContractError("invalid-model-output", 502)
    candidates: list[Candidate] = []
    for candidate in result.candidates:
        candidate_latex = _bounded_text(candidate.latex, MAX_LATEX_BYTES, allow_newlines=True)
        confidence = candidate.confidence
        if confidence is not None:
            confidence = _finite_number(confidence, 0.0, 1.0)
        candidates.append(Candidate(candidate_latex, confidence))
    model_version = result.model_version
    if model_version is not None:
        model_version = _bounded_text(model_version, MAX_SHORT_TEXT_BYTES)
    warnings = tuple(_bounded_text(item, MAX_SHORT_TEXT_BYTES) for item in result.warnings)
    return ModelResult(latex, tuple(candidates), model_version, warnings)


def response_document(result: ModelResult, duration_ms: int) -> bytes:
    checked = validate_model_result(result)
    payload: dict[str, Any] = {
        "latex": checked.latex,
        "candidates": [
            {"latex": item.latex, **({"confidence": item.confidence} if item.confidence is not None else {})}
            for item in checked.candidates
        ],
        "modelVersion": checked.model_version,
        "apiVersion": API_VERSION,
        "processingDurationMs": max(0, min(int(duration_ms), 120_000)),
        "warnings": list(checked.warnings),
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise ContractError("invalid-model-output", 502)
    return encoded
