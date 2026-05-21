# Slice 10a — Maple Hosted (browser-only)

**Goal:** Deliver a production browser-only Maple Hosted that runs the full raw-pipeline in WebAssembly, reads folders via the File System Access API, and reuses the `.maple/` folder cache. No server, no account, no database.

**Current state:** Design prototype copied to `src/maple-hosted/` — see that directory's README. Prototype is React via CDN, placeholder imagery, self-contained HTML.

**Spec pointers:**
- `docs/spec/12-maple-apps-spec.md` § 06 (Maple Hosted).
- `docs/spec/12-maple-apps-spec.md` § 03 (`.maple/` folder cache).
- `docs/spec/00-overview.md` "Web (TypeScript)" (Angular workspace target).
- `src/maple-hosted/Spec.html` (design-handoff interaction spec).

## Architecture

Two possible architectures; pick one before starting P1:

**A. Port the React prototype to Angular** (spec-aligned).
- Angular workspace with three projects per spec § 00: `editor`, `browse`, `Maple-common`.
- Map prototype components to Angular components 1:1; swap `lib/*.jsx` → `editor/src/app/*.component.ts`.
- Use Angular signals for state (spec § 00: "Angular signals for reactive state; no RxJS in the adjustment loop").
- ~2-3 weeks of Angular-specific work.

**B. Keep React + migrate later.**
- Treat prototype as the production UI; add TypeScript + Vite build; ship as-is.
- Faster to first ship (~1 week) but diverges from spec § 00's Angular requirement.
- Harder to merge with Maple Self Hosted's backend-served UI if that assumes Angular.

**Recommendation:** **A**. The Angular workspace structure is called out in spec § 00 and Maple Self Hosted reuses the same UI — committing to React now means two ports later.

## Phases

### P1 — Angular workspace setup (~3 days)
- `ng new maple-hosted` with the three projects scaffolded.
- Port design tokens from `lib/tokens.jsx` to a shared Angular SCSS module.
- Port shared primitives (`MapleIcon`, `MapleButton`, `MapleCollapsible`) as standalone Angular components.
- Root-level routing: `/browse` and `/edit/:id`.

### P2 — Browse mode (~1 week)
- File tree (`lib/tree.jsx` → `browse/src/app/tree.component.ts`).
- Justified grid (`lib/center.jsx` grid section).
- Detail panel Info tab (`lib/detail.jsx` InfoTab).
- Keyboard shortcuts: 1-5 (stars), P (pick), X (reject), /, arrow nav.
- Placeholder imagery for now; real thumbs wait for P5.

### P3 — Full-image mode (~1 week)
- Filmstrip (`lib/center.jsx` + `lib/tree.jsx` filmstrip).
- Image canvas with zoom + pan + before/after divider.
- Detail panel Develop tab with all sliders + live scopes.
- 180ms layout transition between Browse and Full-image.

### P4 — `raw-wasm` integration (~1 week)
- Bundle `raw-wasm` via `wasm-pack build --target web`; publish as npm-local package from `src/raw-pipeline/raw-wasm/`.
- **Blocker**: `raw-wasm` currently takes paths; needs `render_bytes(bytes, ext, xmp)` sibling — add to `raw-core` + `raw-wasm` before starting this phase.
- Web Worker-based decode so the UI doesn't freeze during RAW processing.
- Progressive preview: decode → low-res output (few hundred ms) → full-res output on idle.

### P5 — File System Access API + `.maple/` cache (~1 week)
- Folder picker using `window.showDirectoryPicker()`.
- Security + permissions prompt handling.
- Read/write the `.maple/` folder cache (spec § 03): thumbs, preview JPEGs, index.json, editstack JSON.
- IndexedDB mirror for browsers without full FS Access (Safari stragglers).

### P6 — XMP read + write (~3 days)
- Import sidecars from the folder alongside RAW files.
- Wire the Angular forms to `AdjustmentModel` (reuse `raw-wasm`'s type surface).
- **Blocker**: write path needs the canonical XMP serializer + passthrough buckets in `raw-core` — slice 7 deferred this. Complete before P6.

### P7 — Polish + deploy (~3 days)
- Service worker for offline.
- Build output as static assets; deploy to Cloudflare Pages / Netlify / Vercel.
- End-to-end smoke on 3 browsers (Chrome, Safari, Firefox).

## Deliverables

- Browser app that opens a folder, decodes RAWs via WASM, shows the grid, edits via sliders, writes XMP sidecars, reuses the `.maple/` cache.
- Published at a single URL, zero backend.
- Render parity with CLI within slice-1 ΔE budgets (same `raw-core`, different wrapper).

## Open questions

- Should the prototype's localStorage-based state persistence stay, or migrate to IndexedDB entirely? (localStorage is simpler but lossy on tab close for large data.)
- WebGPU path (spec § 00 mentions WebGL2 first; WebGPU is "considered and rejected for v1" but Safari support is landing) — defer until the WebGL2 path is stable and measured.
- Bun-adjacent: if Maple Self Hosted gets a JS UI bundle anyway, should it be shared with Maple Hosted from day one, or fork later?

## Estimated total: 4-5 weeks for a single engineer.
