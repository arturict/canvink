from __future__ import annotations

import json


TOKEN = "test-token-that-is-at-least-thirty-two-bytes-long"


def request_document() -> dict[str, object]:
    return {
        "protocolVersion": 1,
        "requestId": "request_1234567890",
        "strokes": [
            {
                "points": [
                    {"x": 0.1, "y": 0.2, "pressure": 0.5},
                    {"x": 0.9, "y": 0.8},
                ]
            }
        ],
        "boundingBox": {"x": 0, "y": 0, "width": 200, "height": 100},
        "locale": "de-CH",
        "settings": {"angleMode": "degree", "decimalSeparator": "comma"},
    }


def request_body(document: dict[str, object] | None = None) -> bytes:
    return json.dumps(document or request_document(), separators=(",", ":")).encode("utf-8")


def headers(token: str = TOKEN) -> dict[str, str]:
    return {"authorization": f"Bearer {token}", "content-type": "application/json"}

