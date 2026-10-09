"""Keep current ATM quotes fresh independently of the inventory refresh worker."""
import argparse
import logging
import signal

import _bootstrap  # noqa: F401
from vol_surface.atm_refresh import AtmCurveRefresher, DEFAULT_INTERVAL_SECONDS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", default="project/runtime/dashboard_build")
    parser.add_argument("--interval-seconds", type=float, default=DEFAULT_INTERVAL_SECONDS)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    worker = AtmCurveRefresher(args.artifacts_dir, interval_seconds=args.interval_seconds)
    if not worker.start():
        logging.info("An ATM collector already owns this artifacts directory; exiting")
        return
    def shutdown(*_):
        worker.stop_event.set()
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    try:
        while worker.thread.is_alive() and not worker.stop_event.wait(1):
            pass
    finally:
        worker.stop(timeout=45)


if __name__ == "__main__":
    main()
