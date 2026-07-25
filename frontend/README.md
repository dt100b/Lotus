# Lotus Terminal Frontend

Vite + React + TypeScript UI for the Deribit BTC options **Gamma Exposure** terminal (Phase 5 presentation layer).

## Scripts

```bash
npm install
npm run dev      # local UI (default: mock data)
npm run build
npm run preview
npm run lint
```

## Data modes

| Env | Value | Behavior |
|-----|--------|----------|
| `VITE_LOTUS_DATA_MODE` | `mock` (default in `.env`) | In-browser mock GEX snapshot; no API required |
| `VITE_LOTUS_DATA_MODE` | anything else / omit | Live — fetches `/api/v1/terminal-snapshot` |
| `VITE_LOTUS_API_BASE_URL` | e.g. `http://127.0.0.1:8000` | API origin (defaults to `http://127.0.0.1:8000` in dev) |

Example live local stack:

```powershell
# Terminal A — API
python -m uvicorn project.api.main:app --host 127.0.0.1 --port 8000

# Terminal B — Vite
cd frontend
# .env: VITE_LOTUS_DATA_MODE=live
npm run dev
```

## Performance tooling

Enable the FPS HUD and paint marks:

- URL: `?perf=1`
- Or: `localStorage.setItem('lotusPerf', '1')` then reload

DevTools console will log heat rebuild timings as `[lotus-perf] …`.

## Architecture notes

- Charts: custom Canvas (heatmap) + SVG (GEX profile) with d3-scale/shape
- State: Zustand (UI controls) + TanStack Query (snapshots)
- Expiry switches keep previous snapshot on screen (`keepPreviousData`) to avoid full-shell remounts
- Heatmap uses dual canvases: heat surface + interactive overlay (hover does not rebuild the field)
