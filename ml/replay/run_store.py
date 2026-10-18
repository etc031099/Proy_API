"""Owned local run directories; no URI, service client or external persistence."""
import copy
import json
import os
import re
import shutil
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from ml.service.v3_ridge_training import canonical

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNS = ROOT / "ml/.test-tmp/replay-runs"


class RunStore:
    def __init__(self, run_id, root=DEFAULT_RUNS):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", run_id):
            raise ValueError("REPLAY_RUN_ID_INVALID")
        self.run_id = run_id
        self.root = Path(root).absolute()
        self.path = self.root / run_id
        self._safe(self.path)

    def _safe(self, path):
        path = Path(path).absolute()
        if (not path.is_relative_to(self.root) or not path.resolve().is_relative_to(self.root.resolve())
                or not path.resolve().is_relative_to(self.path.resolve())):
            raise ValueError("REPLAY_PATH_INVALID")
        for item in (path, *path.parents):
            if item.is_symlink():
                raise ValueError("REPLAY_PATH_INVALID")

    def create(self):
        self.root.mkdir(parents=True, exist_ok=True)
        self.path.mkdir()  # exclusive, never overwrite another run
        self.save("owner.json", {"purpose": "REPLAY_ONLY", "demoRunId": self.run_id}, exclusive=True)

    def owned(self):
        self._safe(self.path)
        if self.read("owner.json") != {"purpose": "REPLAY_ONLY", "demoRunId": self.run_id}:
            raise ValueError("REPLAY_OWNER_INVALID")

    def read(self, name):
        path = self.path / name
        self._safe(path)
        return json.loads(path.read_text(encoding="utf-8"))

    def save(self, name, value, *, exclusive=False):
        path = self.path / name
        self._safe(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        if exclusive:
            with path.open("xb") as stream:
                stream.write(canonical(value))
            return
        temporary = path.with_name(path.name + "." + uuid4().hex + ".tmp")
        try:
            temporary.write_bytes(canonical(value))
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    @contextmanager
    def lock(self):
        self.owned()
        lock = self.path / "run.lock"
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise ValueError("REPLAY_RUN_BUSY") from None
        os.close(fd)
        try:
            yield
        finally:
            lock.unlink(missing_ok=True)

    def reset(self):
        with self.lock():
            baseline = self.read("baseline/manifest.json")
            for name in ("candidates", "evidence"):
                target = self.path / name
                self._safe(target)
                if target.exists():
                    for child in target.rglob("*"):
                        self._safe(child)
                    shutil.rmtree(target)
            for name in ("report.json", "formal-evaluation.json"):
                target = self.path / name
                self._safe(target)
                target.unlink(missing_ok=True)
            self.save("manifest.json", baseline)
            return copy.deepcopy(baseline)
