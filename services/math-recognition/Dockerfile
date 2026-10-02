FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    CANVINK_MATH_HOST=0.0.0.0 \
    CANVINK_MATH_PORT=8787

WORKDIR /app
COPY --chown=65532:65532 src/ /app/src/

USER 65532:65532
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/healthz', timeout=2).read()"]

CMD ["python", "-m", "canvink_math_recognition"]
