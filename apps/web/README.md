# SmartCity Web Map

An interactive MapLibre GL front-end that visualises OpenStreetMap tiles via MapTiler, Stadia Maps, or any self-hosted style, and overlays live traffic measurements.

## Prerequisites
- Node.js 18+
- API key for MapTiler or Stadia Maps (optional when using demo or self-hosted tiles)
- Running SmartCity backend (`npm --prefix apps/backend run dev`) to power the traffic overlay

## Quick start
```bash
cd apps/web
npm install
npm run dev
```

Open the URL printed by Vite (defaults to http://localhost:5173).

## Environment variables
Create a `.env` file next to `package.json` or export variables before starting Vite.

| Variable | Purpose | Default |
| --- | --- | --- |
| `VITE_MAP_PROVIDER` | Initial provider (`maptiler`, `stadia`, `custom`) | `maptiler` |
| `VITE_MAPTILER_KEY` | MapTiler API key | empty (required when provider is `maptiler`) |
| `VITE_MAPTILER_STYLE` | MapTiler style id (e.g. `streets-v2`, `outdoor-v2`) | `streets-v2` |
| `VITE_STADIA_KEY` | Stadia Maps API key | empty (demo tiles used when missing) |
| `VITE_STADIA_STYLE` | Stadia style id (e.g. `alidade_smooth`) | `alidade_smooth` |
| `VITE_CUSTOM_STYLE_URL` | Self-hosted MapLibre style JSON | `https://demotiles.maplibre.org/style.json` |
| `VITE_BACKEND_URL` | SmartCity backend base URL (for traffic snapshot API) | `http://localhost:8000` |
| `VITE_TRAFFIC_REFRESH_MS` | Polling interval for traffic overlay (ms) | `4000` |

## Live traffic overlay
1. Start the backend and inference services (see repository README).
2. Run the traffic simulator so fresh measurements flow into the backend:
   ```bash
   python simulator/traffic_sim.py --rate 2 --junction A
   # use other junction ids (B, C, D, E) in extra terminals for multiple points
   ```
3. Launch the web app. The control panel shows the last refresh time, and the map displays coloured circles sized by congestion per junction.

You can replace the simulator with real data that POSTs to `/ingest` — the overlay consumes `/ingest/snapshot?kind=traffic` and renders the latest value per location.

## Connecting to self-hosted tiles
Provide a MapLibre-compatible style JSON that references your tile endpoints (vector `.pbf` or raster `.png`), sprite, and glyph URLs. Ensure the server enables CORS for the web origin running this app.

## Production build
```bash
cd apps/web
npm run build
npm run preview
```

The static build is emitted to `apps/web/dist` and can be hosted by any static file server.
