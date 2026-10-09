"""Analyze a stored Options Surface validation corpus.

Usage:
  python -m project.scripts.analyze_options_surface_corpus --input project/runtime/options_surface_snapshots --from 2026-08-16 --to 2026-09-30
"""

from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from project.options_surface.config import capture_directory
from project.options_surface.corpus.analyze import analyze_corpus


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Summarize Options Surface calibration quality. Not a backtest."
    )
    parser.add_argument("--input", default="", help="Corpus directory.")
    parser.add_argument("--output", default="", help="Report directory (default <input>/reports/<stamp>).")
    parser.add_argument("--from", dest="date_from", default="")
    parser.add_argument("--to", dest="date_to", default="")
    args = parser.parse_args(argv)

    input_dir = Path(args.input or capture_directory())
    start = date.fromisoformat(args.date_from) if args.date_from else None
    end = date.fromisoformat(args.date_to) if args.date_to else None
    if args.output:
        output_dir = Path(args.output)
    else:
        stamp = date.today().isoformat()
        output_dir = input_dir / "reports" / stamp
    report = analyze_corpus(input_dir, start=start, end=end, output_dir=output_dir)
    used = (report.get("run") or {}).get("records_used")
    print(f"records_used {used}")
    print(f"report {output_dir / 'corpus_report.md'}")
    print("This is a calibration-quality report, not a backtest.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
