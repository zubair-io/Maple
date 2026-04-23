# Maple Hosted

Browser-only photo editor. Drop a RAW or pick a folder via the File System Access API; the full raw-pipeline runs in the browser via WebAssembly (`raw-wasm`). No server, no account, no database. See `docs/spec/12-maple-apps-spec.md` § 06.

## Current state (2026-04-22)

**This directory currently contains the design-handoff prototype** from Claude Design. It's a self-contained HTML/JSX React app (no build step) that demonstrates the UI:

- Warm charcoal dark theme per `docs/spec/12-maple-apps-spec.md` and `uploads/dark-mode-prd.md`.
- Three-column adaptive shell: tree / grid / detail.
- Browse mode (tree + justified grid) and Full-image mode (filmstrip + letterboxed image).
- Two detail tabs (Info, Develop) with collapsible sections.
- Traffic-light window chrome, hideable sidebar + inspector.
- Live scopes (histogram / waveform / parade / vectorscope) pinned in the Develop tab.
- Placeholder imagery — no real RAW pipeline wired yet.

**What's NOT done yet** (slice 10a implementation plan — see `docs/superpowers/plans/2026-04-22-slice-10a-maple-hosted.md`):

- **Raw-wasm wiring.** Prototype uses placeholder SVG thumbnails. Real integration needs:
  - A byte-based decode in `raw-core` (currently path-only; see slice 9 deferred item).
  - The `raw-wasm` crate compiled via `wasm-pack build --target web` and packaged as npm.
  - Worker-based decode so the UI doesn't freeze during RAW processing.
- **File System Access API.** Prototype doesn't touch the filesystem; folder picker and `.maple/` cache reuse need real JS/TS.
- **IndexedDB cache.** `.maple/` folder cache (spec § 03) for thumbs and preview JPEGs; per-RAW keyed lookups.
- **Real Angular workspace.** Long-term, the production Maple Hosted is an Angular workspace per `docs/spec/00-overview.md`. The React prototype informs UI but should be ported.
- **XMP sidecar write-out.** slice 7 landed read-only; writing needs the canonical serializer + passthrough buckets.

## Run the prototype locally

```bash
cd /Users/riabuz/Projects/_Maple/src/maple-hosted
python3 -m http.server 8000
# open http://localhost:8000/
```

Or serve with any static file server. The app uses React via CDN (see `index.html` script tags) — no npm install, no build step.

Open `Spec.html` in the same directory for the full interaction spec that accompanied the design handoff.

## Source layout

```
index.html                   entry point (React + Babel via CDN, inline styles)
app.jsx                      top-level composition + keyboard shortcuts
lib/tokens.jsx               color tokens (MapleTokens, MapleFont, MapleMono)
lib/data.jsx                 mock folder + asset data for the prototype
lib/primitives.jsx           MapleIcon, MapleButton, MapleCollapsible, tooltips
lib/tree.jsx                 left-column file tree + filmstrip
lib/center.jsx               middle-column grid (browse) + image canvas (full)
lib/detail.jsx               right-column Info + Develop tabs
lib/scopes.jsx               live histogram / waveform / parade / vectorscope
lib/macos-window.jsx         unused; starter component preserved for reference
Spec.html                    print-ready interaction spec from the design handoff
uploads/dark-mode-prd.md     original PRD that drove the design
DESIGN_BUNDLE_README.md      README from the design handoff bundle
```

## Next steps (see slice 10a plan doc)

1. Decide: React prototype → Angular port, or keep React? Spec says Angular, but Angular-ification is a 2-week task on top of prototype correctness.
2. Wire `raw-wasm` for real RAW decode in a web worker.
3. Implement `.maple/` folder cache protocol (spec § 03) against IndexedDB.
4. File System Access API integration.
5. Deploy to static hosting (Cloudflare Pages / Netlify / Vercel — no server required).
