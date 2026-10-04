from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .paths import ensure_runtime_dirs


LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 5


def _career_handler(handler: logging.Handler) -> bool:
    return bool(getattr(handler, "_career_workflow_handler", False))


def _mark(handler: logging.Handler) -> logging.Handler:
    setattr(handler, "_career_workflow_handler", True)
    return handler


def configure_logging() -> Path:
    """Configure durable app logs without relying on shell redirection."""
    log_path = ensure_runtime_dirs().logs_dir / "api.log"
    formatter = logging.Formatter(LOG_FORMAT)
    app_logger = logging.getLogger("career_workflow")

    existing_file = next(
        (
            handler
            for handler in app_logger.handlers
            if _career_handler(handler)
            and isinstance(handler, RotatingFileHandler)
            and Path(handler.baseFilename) == log_path
        ),
        None,
    )
    if existing_file is None:
        for handler in list(app_logger.handlers):
            if _career_handler(handler) and isinstance(handler, RotatingFileHandler):
                app_logger.removeHandler(handler)
                handler.close()
        file_handler = _mark(
            RotatingFileHandler(
                log_path,
                maxBytes=LOG_MAX_BYTES,
                backupCount=LOG_BACKUP_COUNT,
                encoding="utf-8",
            )
        )
        file_handler.setFormatter(formatter)
        app_logger.addHandler(file_handler)

    if not any(_career_handler(handler) and isinstance(handler, logging.StreamHandler) and not isinstance(handler, RotatingFileHandler) for handler in app_logger.handlers):
        console_handler = _mark(logging.StreamHandler())
        console_handler.setFormatter(formatter)
        app_logger.addHandler(console_handler)

    app_logger.setLevel(logging.INFO)
    app_logger.propagate = False
    return log_path
