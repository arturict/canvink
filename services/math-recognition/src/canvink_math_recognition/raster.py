"""Bounded, dependency-free rasterization of normalized selected ink."""

from __future__ import annotations

from dataclasses import dataclass
import math

from .contract import RecognitionRequest


MAX_RASTER_DIMENSION = 2_048
MAX_RASTER_PIXELS = 4_194_304
MAX_DRAW_OPERATIONS = 2_000_000


class RasterLimitError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Raster:
    width: int
    height: int
    grayscale: bytes

    def to_pgm(self) -> bytes:
        return f"P5\n{self.width} {self.height}\n255\n".encode("ascii") + self.grayscale


def _dimensions(width: float, height: float) -> tuple[int, int]:
    scale = min(
        1.0,
        MAX_RASTER_DIMENSION / width,
        MAX_RASTER_DIMENSION / height,
        math.sqrt(MAX_RASTER_PIXELS / (width * height)),
    )
    return max(1, round(width * scale)), max(1, round(height * scale))


def rasterize(request: RecognitionRequest) -> Raster:
    width, height = _dimensions(request.bounding_box.width, request.bounding_box.height)
    pixels = bytearray([255]) * (width * height)
    operations = 0

    def paint(x: int, y: int) -> None:
        nonlocal operations
        operations += 1
        if operations > MAX_DRAW_OPERATIONS:
            raise RasterLimitError
        if 0 <= x < width and 0 <= y < height:
            pixels[y * width + x] = 0

    def pixel(point_x: float, point_y: float) -> tuple[int, int]:
        return round(point_x * (width - 1)), round(point_y * (height - 1))

    for stroke in request.strokes:
        previous: tuple[int, int] | None = None
        for point in stroke.points:
            current = pixel(point.x, point.y)
            if previous is None:
                paint(*current)
            else:
                x0, y0 = previous
                x1, y1 = current
                dx = abs(x1 - x0)
                sx = 1 if x0 < x1 else -1
                dy = -abs(y1 - y0)
                sy = 1 if y0 < y1 else -1
                error = dx + dy
                while True:
                    paint(x0, y0)
                    if x0 == x1 and y0 == y1:
                        break
                    doubled = 2 * error
                    if doubled >= dy:
                        error += dy
                        x0 += sx
                    if doubled <= dx:
                        error += dx
                        y0 += sy
            previous = current
    return Raster(width, height, bytes(pixels))

