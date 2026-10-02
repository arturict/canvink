from __future__ import annotations

import unittest

from canvink_math_recognition.contract import parse_request
from canvink_math_recognition.raster import MAX_RASTER_DIMENSION, MAX_RASTER_PIXELS, rasterize

from .helpers import request_body, request_document


class RasterTests(unittest.TestCase):
    def test_raster_contains_only_passed_selected_strokes(self) -> None:
        value = request_document()
        value["strokes"] = [{"points": [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 1.0}]}]
        value["boundingBox"] = {"x": 0, "y": 0, "width": 8, "height": 8}
        raster = rasterize(parse_request(request_body(value)))
        self.assertEqual((raster.width, raster.height), (8, 8))
        self.assertEqual(raster.grayscale[0], 0)
        self.assertEqual(raster.grayscale[-1], 0)
        self.assertEqual(raster.grayscale[7], 255)
        self.assertNotIn(b"secret", raster.to_pgm())

    def test_raster_dimensions_and_memory_are_bounded(self) -> None:
        value = request_document()
        value["boundingBox"] = {"x": 0, "y": 0, "width": 8192, "height": 8192}
        raster = rasterize(parse_request(request_body(value)))
        self.assertLessEqual(raster.width, MAX_RASTER_DIMENSION)
        self.assertLessEqual(raster.height, MAX_RASTER_DIMENSION)
        self.assertLessEqual(len(raster.grayscale), MAX_RASTER_PIXELS)


if __name__ == "__main__":
    unittest.main()

