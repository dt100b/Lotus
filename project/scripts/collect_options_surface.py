"""Repeatable Options Surface collection runner.

Disabled unless LOTUS_SURFACE_COLLECT_ENABLED=true (or --enable).

Usage:
  python -m project.scripts.collect_options_surface --once
  python -m project.scripts.collect_options_surface --loop
  python -m project.scripts.collect_options_surface --once --dry-run
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import logging
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "project"
for path in (str(ROOT), str(PROJECT)):
    if path not in sys.path:
        sys.path.insert(0, path)

from project.options_surface.config import (
    capture_directory,
    collect_enabled,
    collect_interval_seconds,
    load_serving_config,
    max_curated_expiries,
)
from project.options_surface.corpus.collector import (
    CaptureProviders,
    configure_logging,
    run_collection,
)
from project.options_surface.corpus.lock import InstanceLock
from project.options_surface.corpus.store import CorpusSnapshotStore
from project.scripts.capture_options_surface import _live_providers

LOGGER = logging.getLogger("lotus.options_surface.collector")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collect Options Surface corpus snapshots.")
    parser.add_argument("--once", action="store_true", help="One batch, then exit.")
    parser.add_argument("--loop", action="store_true", help="Repeat on the configured cadence.")
    parser.add_argument("--enable", action="store_true", help="Override LOTUS_SURFACE_COLLECT_ENABLED.")
    parser.add_argument("--underlying", default="BTC")
    parser.add_argument("--expiry", action="append", default=[])
    parser.add_argument("--curated-expiries", action="store_true", default=True)
    parser.add_argument("--no-curated-expiries", action="store_false", dest="curated_expiries")
    parser.add_argument("--output", default="")
    parser.add_argument("--interval-seconds", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--log-file", default="")
    args = parser.parse_args(argv)

    if not args.once and not args.loop:
        parser.error("Specify --once or --loop.")
    if not args.enable and not collect_enabled() and not args.dry_run:
        print("Collection is disabled. Set LOTUS_SURFACE_COLLECT_ENABLED=true or pass --enable.")
        return 2

    output = Path(args.output or capture_directory())
    log_path = Path(args.log_file) if args.log_file else output / "logs" / "collector.log"
    configure_logging(log_path)
    store = CorpusSnapshotStore(output)
    lock = InstanceLock(output / "locks" / "collector.lock")
    providers = _live_providers(args.underlying)
    config = load_serving_config()
    interval = args.interval_seconds or collect_interval_seconds()

    def run_once() -> dict:
        return run_collection(
            store=store,
            providers=providers,
            underlying=args.underlying.upper(),
            expiries=args.expiry or None,
            curated=bool(args.curated_expiries) and not args.expiry,
            dry_run=args.dry_run,
            serving_config=config,
            max_expiries=max_curated_expiries(),
            lock=lock,
        )

    if args.once:
        summary = run_once()
        _print_summary(summary)
        return 0 if summary.get("ok", True) or args.dry_run else 1

    LOGGER.info("loop start interval_seconds=%s output=%s", interval, output)
    while True:
        started = datetime.now(UTC)
        try:
            summary = run_once()
            _print_summary(summary)
        except RuntimeError as exc:
            LOGGER.error("%s", exc)
        except Exception:
            LOGGER.exception("collection batch failed")
        elapsed = (datetime.now(UTC) - started).total_seconds()
        sleep_for = max(interval - elapsed, 1.0)
        LOGGER.info("sleeping %.1fs", sleep_for)
        time.sleep(sleep_for)


def _print_summary(summary: dict) -> None:
    print(
        f"{summary.get('as_of_utc')} captured={summary.get('captured')} "
        f"failed={summary.get('failed')} requested={summary.get('requested')}"
    )


if __name__ == "__main__":
    raise SystemExit(main())
