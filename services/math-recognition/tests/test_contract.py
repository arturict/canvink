from __future__ import annotations

import json
import unittest

from canvink_math_recognition.contract import (
    ContractError,
    MAX_BODY_BYTES,
    MAX_POINTS_PER_STROKE,
    MAX_STROKES,
    parse_request,
)

from .helpers import request_body, request_document


class ContractTests(unittest.TestCase):
    def test_valid_request_preserves_only_local_normalized_selection(self) -> None:
        parsed = parse_request(request_body())
        self.assertEqual(parsed.request_id, "request_1234567890")
        self.assertEqual(parsed.bounding_box.width, 200)
        self.assertEqual(parsed.strokes[0].points[0].x, 0.1)
        self.assertFalse(hasattr(parsed, "page_id"))

    def test_unknown_page_pdf_image_and_absolute_origin_fields_are_rejected(self) -> None:
        for key in ("pageId", "notebookId", "pdf", "image", "adjacentInk"):
            with self.subTest(key=key):
                value = request_document()
                value[key] = "secret-page-content"
                with self.assertRaises(ContractError):
                    parse_request(request_body(value))
        value = request_document()
        value["boundingBox"] = {"x": 10, "y": 0, "width": 200, "height": 100}
        with self.assertRaises(ContractError):
            parse_request(request_body(value))

    def test_malformed_duplicate_nonfinite_and_boolean_numbers_are_rejected(self) -> None:
        bodies = [
            b"{",
            b'{"protocolVersion":1,"protocolVersion":1}',
            request_body({**request_document(), "protocolVersion": True}),
            request_body({**request_document(), "protocolVersion": 1.0}),
            request_body({**request_document(), "boundingBox": {"x": 0, "y": 0, "width": float("nan"), "height": 1}}),
            b'{"protocolVersion":' + (b"9" * 5_000) + b"}",
        ]
        for body in bodies:
            with self.subTest(body=body[:30]):
                with self.assertRaises(ContractError):
                    parse_request(body)

    def test_hard_body_stroke_point_and_bbox_limits(self) -> None:
        with self.assertRaises(ContractError) as body_error:
            parse_request(b"x" * (MAX_BODY_BYTES + 1))
        self.assertEqual(body_error.exception.status, 413)

        too_many_strokes = request_document()
        too_many_strokes["strokes"] = [{"points": [{"x": 0, "y": 0}]}] * (MAX_STROKES + 1)
        with self.assertRaises(ContractError) as stroke_error:
            parse_request(request_body(too_many_strokes))
        self.assertEqual(stroke_error.exception.status, 413)

        too_many_points = request_document()
        too_many_points["strokes"] = [
            {"points": [{"x": 0, "y": 0}] * (MAX_POINTS_PER_STROKE + 1)}
        ]
        with self.assertRaises(ContractError) as point_error:
            parse_request(request_body(too_many_points))
        self.assertEqual(point_error.exception.status, 413)

        bad_box = request_document()
        bad_box["boundingBox"] = {"x": 0, "y": 0, "width": 8193, "height": 10}
        with self.assertRaises(ContractError):
            parse_request(request_body(bad_box))

    def test_zero_strokes_is_invalid_not_oversize(self) -> None:
        value = request_document()
        value["strokes"] = []
        with self.assertRaises(ContractError) as error:
            parse_request(request_body(value))
        self.assertEqual(error.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
