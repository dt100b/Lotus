"""Refresh only the current ATM curve, without replaying or writing GEX inventory."""
import json
import time
from pathlib import Path
import argparse

import _bootstrap  # noqa: F401
from greeks.providers import DeribitPublicGreeksProvider, write_greeks_snapshot_json
from vol_surface.atm_term import build_atm_term_curve, FILENAME


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", default="project/runtime/dashboard_build")
    args = parser.parse_args()
    with DeribitPublicGreeksProvider() as provider:
        quotes = provider.fetch_near_atm_greeks()
    payload = build_atm_term_curve(quotes, as_of_ms=int(time.time()*1000))
    root = Path(args.artifacts_dir)
    root.mkdir(parents=True, exist_ok=True)
    write_greeks_snapshot_json(quotes, root / "atm_term_quotes.json")
    temp = (root / FILENAME).with_suffix(".tmp")
    temp.write_text(json.dumps(payload,indent=2),encoding="utf-8")
    temp.replace(root / FILENAME)
    print(json.dumps(payload,indent=2))


if __name__ == "__main__":
    main()
