"""Write a timestamped options-surface rejection diagnostic.

Usage:
  .\\.venv\\Scripts\\python.exe -m project.scripts.diagnose_options_surface
  .\\.venv\\Scripts\\python.exe -m project.scripts.diagnose_options_surface --expiry 2026-08-21
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from project.options_surface.diagnostics import write_live_rejection_artifact


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expiry", default="2026-08-21")
    parser.add_argument("--snapshot", default="")
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    parser.add_argument("--stamp", default="")
    args = parser.parse_args()

    snapshot_path = Path(args.snapshot) if args.snapshot else (
        ROOT / "project" / "runtime" / "dashboard_build" / "options_surface"
        / f"latest_BTC_{args.expiry}.json"
    )
    if not snapshot_path.exists():
        raise SystemExit(f"snapshot not found: {snapshot_path}")
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    api_payload = _fetch_live(args.api, args.expiry)
    stamp = args.stamp or datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    paths = write_live_rejection_artifact(
        snapshot=snapshot,
        output_root=ROOT / "runtime" / "options_surface_debug",
        docs_dir=ROOT / "docs" / "diagnostics",
        api_payload=api_payload,
        stamp=stamp,
    )
    print(f"report {paths['report']}")
    print(f"runtime {paths['runtime']}")
    return 0


def _fetch_live(api: str, expiry: str) -> dict | None:
    url = f"{api.rstrip('/')}/api/v1/options-surface?expiry={expiry}"
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None


if __name__ == "__main__":
    raise SystemExit(main())
