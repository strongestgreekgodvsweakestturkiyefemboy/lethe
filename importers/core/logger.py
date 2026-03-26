from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

_LOG_LEVEL_ENV = os.environ.get("LOG_LEVEL", "DEBUG").upper()
_LOG_LEVEL = getattr(logging, _LOG_LEVEL_ENV, logging.DEBUG)

# Log directory: LOG_DIR env var or <project_root>/logs
_LOG_DIR = Path(os.environ.get("LOG_DIR", str(Path(__file__).resolve().parent.parent.parent / "logs")))
_LOG_DIR.mkdir(parents=True, exist_ok=True)

_LOG_FILE = _LOG_DIR / "importers.log"

_LOG_FORMAT = "%(asctime)s [importers] %(levelname)s %(name)s: %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

_formatter = logging.Formatter(fmt=_LOG_FORMAT, datefmt=_DATE_FORMAT)


def get_logger(name: str) -> logging.Logger:
    """Return a named logger that writes to console and to the log file."""
    log = logging.getLogger(name)
    if log.handlers:
        return log  # already configured

    log.setLevel(_LOG_LEVEL)

    # Console handler
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(_LOG_LEVEL)
    ch.setFormatter(_formatter)
    log.addHandler(ch)

    # Rotating file handler (10 MiB × 5 files)
    fh = RotatingFileHandler(
        _LOG_FILE,
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    fh.setLevel(_LOG_LEVEL)
    fh.setFormatter(_formatter)
    log.addHandler(fh)

    log.propagate = False
    return log
