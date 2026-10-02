# Canvink compatible recognition API v1

The service exposes exactly two routes:

- `GET /healthz`
- `POST /v1/math/recognize`

`POST /v1/math/recognize` requires one `Authorization: Bearer <token>` header,
`Content-Type: application/json`, a numeric `Content-Length`, and no
`Transfer-Encoding`. The maximum request body is 524,288 bytes.

## Request

```json
{
  "protocolVersion": 1,
  "requestId": "request_1234567890",
  "strokes": [
    {
      "points": [
        { "x": 0.1, "y": 0.2, "pressure": 0.5 },
        { "x": 0.9, "y": 0.8 }
      ]
    }
  ],
  "boundingBox": { "x": 0, "y": 0, "width": 200, "height": 100 },
  "locale": "de-CH",
  "settings": { "angleMode": "degree", "decimalSeparator": "comma" }
}
```

The object and every nested object reject unknown or duplicate keys.

| Field | Contract |
| --- | --- |
| `protocolVersion` | Integer `1`; booleans are rejected |
| `requestId` | 16-128 ASCII letters, digits, `_`, or `-` |
| `strokes` | 1-256 selected strokes |
| `points` | 1-4,096 per stroke; 16,384 total |
| `x`, `y` | Finite normalized number from `0` through `1` |
| `pressure` | Optional finite number from `0` through `1` |
| `boundingBox.x/y` | Exactly `0`; absolute page origins are not accepted |
| `boundingBox.width/height` | Greater than `0`, at most `8,192` |
| `locale` | Bounded ASCII BCP-47-shaped tag, at most 35 bytes |
| `angleMode` | `degree` or `radian` |
| `decimalSeparator` | `dot` or `comma` |

There is deliberately no notebook, page, PDF, neighboring ink, source image,
file path, URL, or absolute-position field. The server creates a bounded
in-memory grayscale raster solely from the normalized strokes in this request.

## Successful response

```json
{
  "latex": "x^2+1",
  "candidates": [
    { "latex": "x^2+l", "confidence": 0.2 }
  ],
  "modelVersion": "operator-declared-model-version",
  "apiVersion": "v1",
  "processingDurationMs": 812,
  "warnings": []
}
```

The response is `application/json`, at most 262,144 bytes, and contains exactly
the fields shown above. LaTeX is at most 65,536 UTF-8 bytes. There are at most
five candidates and 32 bounded warnings. Confidence is finite and between zero
and one. Model and warning strings are at most 128 UTF-8 bytes.

Errors use a content-free object such as:

```json
{"error":{"code":"invalid-input","message":"The recognition request is invalid."}}
```

No error includes a token, request identifier, stroke, formula, model stderr,
path, environment value, or upstream exception text.

## Health

`GET /healthz` returns only readiness, API version, adapter kind, and declared
model version. It never returns tokens, paths, endpoints, environment values,
GPU details, or request content.

