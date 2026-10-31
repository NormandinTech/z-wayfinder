# Z Wayfinder

Route planning for any DayZ map. Players tap where they are and where they're going and get a road route with turn-by-turn directions. Server owners set up their own map; optional live position is planned at $2/month.

Z Wayfinder ships no map art. Server owners upload a map image they made or have permission to use. Z Wayfinder is a fan-made tool, not affiliated with or authorized by Bohemia Interactive a.s. DayZ is a trademark of Bohemia Interactive a.s.

## Files

- `index.html`: player page. Pick a map, tap start and destination, get the route and directions.
- `editor.html`: owner map setup. Upload a map image (or stitch one from in-game screenshots), click a road colour, trace roads, fix them, add place names, test routes, save a map file.
- `tracer.js`: turns a map image into a road graph (colour mask, clutter filter, thinning, gap joining). Runs in a Web Worker via `trace-worker.js`, or in Node.
- `stitch.js`: lines up a grid of overlapping in-game map screenshots into one image (coarse-to-fine normalized cross-correlation, then weighted relaxation). Runs in a Web Worker via `stitch-worker.js`.
- `router.js`: shared routing engine (road graph, off-road legs, turn-by-turn directions).
- `maps/maps.json`: list of published maps for the player page; each map lives in `maps/<id>/` (`map.jpg`, `roads.json`, `towns.json`).

## Roadmap

1. Publishing: owners publish from the editor and get a player link per server.
2. Live position ($2/month): a free server-side script reports positions; players sign in with Steam and see only their own dot.
