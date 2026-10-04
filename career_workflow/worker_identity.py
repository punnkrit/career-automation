from __future__ import annotations

import os
import tempfile
from pathlib import Path
from uuid import UUID, uuid4


def worker_id(identity_dir: Path | None = None) -> str:
    """A portable, per-installation ID; never a credential or application data."""
    directory = identity_dir or Path.home() / ".config" / "career-automation"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "worker-id"
    if not target.exists():
        descriptor, temporary = tempfile.mkstemp(prefix=".worker-id-", dir=directory)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(str(uuid4()) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temporary, target)
            except FileExistsError:
                pass
        finally:
            Path(temporary).unlink(missing_ok=True)
    return str(UUID(target.read_text(encoding="utf-8").strip()))
