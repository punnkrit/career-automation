from __future__ import annotations

import re


LOCAL_PATH_PATTERN = re.compile(r"(?:[A-Za-z]:[\\/]|/(?:home|mnt|tmp)/)[^\r\n]*")


def safe_error_message(error: BaseException | str) -> str:
    message = str(error).strip() or "The operation failed."
    return LOCAL_PATH_PATTERN.sub("<local path>", message)
