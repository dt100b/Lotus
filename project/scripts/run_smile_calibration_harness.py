"""Run the three-candidate smile calibration harness.

Usage:
  .\\.venv\\Scripts\\python.exe -m project.scripts.run_smile_calibration_harness
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from project.options_surface.surface.harness import DEFAULT_OUTPUT, run_harness


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--skip-live", action="store_true")
    args = parser.parse_args()
    report = run_harness(output_dir=Path(args.output), include_live=not args.skip_live)
    print(f"cases {len(report['cases'])}")
    print(f"wrote {Path(args.output) / 'harness_report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
