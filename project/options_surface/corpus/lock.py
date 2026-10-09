"""Single-instance lock for the collection runner."""

from __future__ import annotations

from pathlib import Path
import sys
from typing import IO


class InstanceLock:
    """Exclusive lock file. Non-blocking. Works on Windows and POSIX."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._handle: IO[str] | None = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+", encoding="utf-8")
        try:
            if sys.platform == "win32":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        handle.seek(0)
        handle.truncate()
        handle.write("locked\n")
        handle.flush()
        self._handle = handle
        return True

    def release(self) -> None:
        handle = self._handle
        self._handle = None
        if handle is None:
            return
        try:
            if sys.platform == "win32":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        handle.close()

    def __enter__(self) -> "InstanceLock":
        if not self.acquire():
            raise RuntimeError(f"Another collector holds {self.path}.")
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()
