from __future__ import annotations

from pathlib import Path
import sys

# Scripts import pipeline and greeks as top-level packages, so project/ stays
# first. The desk surface also imports project.options_surface, which needs the
# repo root on the path. A bare options_surface import is shadowed under pytest
# by project/tests/options_surface.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PROJECT_ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
