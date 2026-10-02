# Private math-recognition reference service

This folder is a private experiment and interoperability reference for Canvink's
compatible `POST /v1/math/recognize` endpoint. It is not approved for public
release, public deployment, multi-tenant use, or a paid Canvink quota. Keep it
on a trusted LAN or behind Tailscale and an authenticated private route.

The service has no third-party runtime dependencies. It validates a deliberately
narrow request, rasterizes only explicitly supplied normalized block strokes in
memory, then calls an operator-managed local model wrapper. It never accepts or
reads a page, PDF, adjacent note, URL, or source image and never downloads a
model.

The exact API is documented in [API.md](API.md).

## Security boundary

- A bearer token of 32-4,096 printable ASCII bytes is mandatory.
- Request, stroke, point, bounding-box, raster work, model timeout, model output,
  response, and model concurrency limits are enforced.
- Duplicate JSON keys, unknown keys, absolute origins, chunked bodies, duplicate
  authorization headers, malformed numbers, and non-JSON media types fail closed.
- Rasterization is dependency-free, bounded to 2,048 pixels per dimension,
  4,194,304 pixels, and 2,000,000 drawing operations.
- Access logs are disabled. Application logs contain only an event class, HTTP
  status, and elapsed milliseconds. Tokens, request IDs, strokes, formulas,
  runner stderr, paths, and exception text are not logged.
- Model subprocesses inherit a small environment allowlist. Provider tokens are
  never inherited. Hugging Face, Transformers, and dataset offline flags are
  forced for each runner.
- Offline environment flags are defense in depth, not an OS network sandbox.
  The private host/container must also deny model-runner egress; the supplied
  wrapper is trusted operator code and must load only local weights.
- The service provides HTTP only. Use Tailscale or a private TLS reverse proxy;
  do not expose port 8787 to the public internet.

## Local contract run

Python 3.12 is required. From this directory:

```powershell
$env:PYTHONPATH = "$PWD\src"
$env:CANVINK_MATH_BEARER_TOKEN = '<at-least-32-random-printable-characters>'
$env:CANVINK_MATH_MODEL_ADAPTER = 'fake'
$env:CANVINK_MATH_ALLOW_FAKE_MODEL = '1'
python -m canvink_math_recognition
```

The fake adapter is for tests and local protocol checks only. Startup refuses it
unless `CANVINK_MATH_ALLOW_FAKE_MODEL=1` is explicit.

## TexTeller experiment adapter

TexTeller is optional and is not installed or downloaded here. An operator must
provide a local installation directory containing
`canvink_texteller_runner.py`. The wrapper receives one binary PGM raster on
stdin and emits one JSON object on stdout:

```json
{
  "latex": "x^2+1",
  "candidates": [{ "latex": "x^2+l", "confidence": 0.2 }],
  "modelVersion": "exact-local-model-version",
  "warnings": []
}
```

Runner stdout is capped at 262,144 bytes, stderr is discarded, execution has a
maximum 15-second timeout, and shell invocation is never used. Configure:

```text
CANVINK_MATH_MODEL_ADAPTER=texteller
CANVINK_TEXTELLER_INSTALL_DIR=<absolute trusted local directory>
CANVINK_TEXTELLER_MODEL_VERSION=<exact local version>
CANVINK_TEXTELLER_PYTHON=<optional Python inside that install tree>
```

The wrapper must load only already-installed local code and weights. TexTeller's
code, model, training-data, and commercial-use rights have not been cleared for
a Canvink release. Until that review is complete, this remains a private
experiment and must not be described as the released standard provider.

## UniMERNet benchmark alternative

UniMERNet is supported only as a private comparison adapter for the same
benchmark harness. It is not a product provider and is never the default. It
uses the identical PGM/stdout protocol with an operator-supplied
`canvink_unimernet_runner.py`:

```text
CANVINK_MATH_MODEL_ADAPTER=unimernet-benchmark
CANVINK_UNIMERNET_INSTALL_DIR=<absolute trusted local directory>
CANVINK_UNIMERNET_MODEL_VERSION=<exact local version>
CANVINK_UNIMERNET_PYTHON=<optional Python inside that install tree>
```

No UniMERNet code, dependency, or model is installed or downloaded by this
service.

## Docker

The Dockerfile pins Python to `3.12.11-slim-bookworm` and an immutable image
digest, copies only the service source, runs as numeric non-root user `65532`,
and installs no packages. A model installation and runner must be supplied by
the private operator at runtime; the image itself contains neither TexTeller nor
UniMERNet.

Building an image does not publish or deploy it:

```powershell
docker build -t canvink-math-recognition:private .
```

Do not put bearer tokens in the image, Dockerfile, command line, workspace, or
logs. Provide them through the private host's secret injection facility.

## Tests

```powershell
$env:PYTHONPATH = "$PWD\src"
python -m unittest discover -s tests -t . -v
python -m compileall -q src tests
```

Tests cover auth, duplicate headers, malformed and oversized inputs, strict
schema privacy, bounded safe rasterization, output limits, timeouts, content-free
logs, fake inference, isolated TexTeller and UniMERNet runner façades, real local
HTTP behavior, and content-free benchmark evidence. Tests perform no external
network request and no model download.

## Private benchmark evidence

Put only self-created or explicitly released request JSON files in a local
directory outside the repository. Never use noncommercial research datasets as
product training or acceptance material. Then run:

```powershell
python -m canvink_math_recognition.benchmark C:\private\authorized-math-corpus `
  --gpu RTX-2070 --writer-count 5 --rights-basis self-created --provenance-reviewed `
  --license-manifest-sha256 <LOWERCASE_SHA256> --model-artifact-sha256 <LOWERCASE_SHA256> `
  --basic-correct 270 --basic-total 300 `
  --overall-correct 240 --overall-total 300 `
  --output C:\private\evidence\rtx-2070.measurement.json
```

Run the same reviewed corpus and exact model artifact independently on the
second intended GPU. Then, from the exact clean Canvink checkout being accepted,
combine the two content-free measurements with explicit bindings:

```powershell
python -m canvink_math_recognition.benchmark `
  --acceptance-measurements C:\private\evidence\rtx-2070.measurement.json C:\private\evidence\rtx-5060.measurement.json `
  --repository-commit <CURRENT_LOWERCASE_40_HEX_COMMIT> `
  --package-version 0.2.0-beta.1 `
  --output-dir test-results\math-canvas-acceptance
```

This writes `recognition-corpus.json` and `gpu-latency.json` directly in the
validator's exact envelopes. A below-threshold run is emitted with
`status: "failed"`, never relabeled as passed. The records contain only hashes,
counts, provenance decisions, timings, GPU classes, and explicit commit/package
bindings. They never contain file names, paths, request/writer IDs, strokes,
raster data, formulas, candidates, or LaTeX. The exact output shape is shown in
`acceptance-evidence-template.json`.

The required real RTX 2070 and RTX 5060 measurements remain open. No benchmark
claim should be made until both are run on the authorized corpus and the
generated evidence is reviewed.
