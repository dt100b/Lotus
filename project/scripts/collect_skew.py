"""Collect independent BTC 25/10-delta skew on ten-minute UTC boundaries."""
import argparse
import json
import logging
import signal

import _bootstrap  # noqa: F401
from vol_surface.skew_refresh import SkewRefresher, INTERVAL_SECONDS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", default="project/runtime/dashboard_build")
    parser.add_argument("--interval-seconds", type=float, default=INTERVAL_SECONDS)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    worker = SkewRefresher(args.artifacts_dir, interval_seconds=args.interval_seconds)
    if args.once:
        if not worker.lease.acquire():
            raise SystemExit("A skew collector already owns this directory")
        try:
            with worker.provider_factory() as provider:
                worker.refresh_once(provider)
            print(json.dumps(worker.status))
            if worker.status["state"] != "ok":
                raise SystemExit(1)
        finally:
            worker.lease.close()
        return
    if not worker.start():
        logging.info("A skew collector already owns this directory; exiting")
        return
    def shutdown(*_):
        worker.stop_event.set()
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    try:
        while worker.thread.is_alive() and not worker.stop_event.wait(1):
            pass
    finally:
        worker.stop()


if __name__ == "__main__":
    main()
