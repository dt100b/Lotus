"""One-shot Options Surface corpus capture.

Usage:
  python -m project.scripts.capture_options_surface --underlying BTC --expiry 2026-08-21
  python -m project.scripts.capture_options_surface --underlying BTC --curated-expiries
  python -m project.scripts.capture_options_surface --underlying BTC --curated-expiries --dry-run
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "project"
for path in (str(ROOT), str(PROJECT)):
    if path not in sys.path:
        sys.path.insert(0, path)

from project.options_surface.config import (
    capture_directory,
    default_serving_config,
    load_serving_config,
    max_curated_expiries,
)
from project.options_surface.corpus.collector import (
    CaptureProviders,
    configure_logging,
    run_collection,
)
from project.options_surface.corpus.store import CorpusSnapshotStore
from project.options_surface.market_data.futures import DeribitFuturesProvider
from project.options_surface.timeutil import as_utc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Capture immutable Options Surface snapshots.")
    parser.add_argument("--underlying", default="BTC")
    parser.add_argument("--expiry", action="append", default=[], help="ISO expiry; repeatable.")
    parser.add_argument("--curated-expiries", action="store_true")
    parser.add_argument("--output", default="", help="Corpus directory (default LOTUS_SURFACE_CAPTURE_DIR).")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-expiries", type=int, default=0)
    parser.add_argument("--pause-seconds", type=float, default=1.0)
    parser.add_argument("--serving-mode", default="")
    args = parser.parse_args(argv)
    if not args.expiry and not args.curated_expiries:
        parser.error("Specify --expiry or --curated-expiries.")

    configure_logging()
    config = load_serving_config() if not args.serving_mode else load_serving_config(
        {"mode": args.serving_mode}
    )
    _ = default_serving_config
    output = Path(args.output or capture_directory())
    store = CorpusSnapshotStore(output)
    providers = _live_providers(args.underlying)
    summary = run_collection(
        store=store,
        providers=providers,
        underlying=args.underlying.upper(),
        expiries=args.expiry or None,
        curated=args.curated_expiries,
        dry_run=args.dry_run,
        serving_config=config,
        max_expiries=args.max_expiries or max_curated_expiries(),
        pause_seconds=args.pause_seconds,
    )
    print(f"as_of_utc {summary['as_of_utc']}")
    print(f"requested {summary['requested']}")
    print(f"captured {summary['captured']}")
    print(f"failed {summary['failed']}")
    print(f"output {output}")
    return 0 if summary.get("ok", True) or args.dry_run else 1


def _live_providers(underlying: str) -> CaptureProviders:
    from pipeline.deribit_iv_chain import DeribitIvChainProvider
    from collector.deribit_client import DeribitPublicClient

    chain = DeribitIvChainProvider()
    futures = DeribitFuturesProvider(currency=underlying.upper())
    client = DeribitPublicClient()

    def fetch_chain(expiry: str | None):
        if expiry:
            return chain.fetch(expiry=expiry)
        return chain.fetch()

    def fetch_instruments(currency: str):
        return client.get_instruments(currency=currency, kind="option", expired=False)

    return CaptureProviders(
        fetch_chain=fetch_chain,
        fetch_futures=futures.fetch,
        fetch_instruments=fetch_instruments,
        clock=lambda: as_utc(datetime.now(UTC)),
    )


if __name__ == "__main__":
    raise SystemExit(main())
