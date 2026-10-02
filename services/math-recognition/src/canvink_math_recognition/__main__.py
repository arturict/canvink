"""Service entry point."""

from __future__ import annotations

import logging
import os

from .app import build_application_from_environment, serve


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        application = build_application_from_environment()
        host = os.environ.get("CANVINK_MATH_HOST", "127.0.0.1")
        port = int(os.environ.get("CANVINK_MATH_PORT", "8787"))
        if not 1 <= port <= 65_535:
            raise ValueError
        serve(application, host, port)
    except Exception:
        logging.error("event=startup_failed")
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
