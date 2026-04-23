# maple-hosted — Production Angular Workspace

Browser-only Maple photo editor. No server, no account, no database. The full RAW pipeline runs in the browser via WebAssembly (`raw-wasm`). See `docs/spec/00-overview.md` and `docs/spec/12-maple-apps-spec.md` § 06.

## Workspace structure

This directory is an **Angular workspace** with three projects, generated per spec § 00 "Web (TypeScript)":

```
angular.json            workspace configuration
package.json            npm dependencies
tsconfig*.json          TypeScript configurations
projects/
  editor/               RAW editor application (the main canvas + develop panel)
  browse/               Library browser application (folder tree + grid view)
  Maple-common/         Shared library: models, XMP parser/serializer, domain types
_design-reference/      React-via-CDN prototype (visual/interaction reference — NOT production)
```

## Angular dev server

```bash
cd src/maple-hosted
npm install
ng serve editor          # serves the editor app at http://localhost:4200/
ng serve browse          # serves the browse app at http://localhost:4200/
```

Or via npm scripts:

```bash
npm start                # serves the default project (editor)
```

## Build

```bash
ng build editor --configuration=production
ng build browse --configuration=production
ng build Maple-common
```

Output lands in `dist/` (gitignored at repo root).

## View the React prototype (design reference)

The `_design-reference/` subdirectory contains the Claude Design handoff — a self-contained HTML/JSX React app that demonstrates the Coral Maple UI with pixel accuracy. Use it as a visual and interaction reference while porting components to Angular.

```bash
cd _design-reference
python3 -m http.server 8000
# open http://localhost:8000/
```

Open `_design-reference/Spec.html` for the full interaction spec that accompanied the design handoff.

## Next steps

See `docs/superpowers/plans/2026-04-22-slice-10a-maple-hosted.md` for the full implementation plan, including:

- Port `_design-reference` components into Angular (editor + browse projects).
- Wire `raw-wasm` for real RAW decode in a web worker.
- Implement `.maple/` folder cache protocol (spec § 03) against IndexedDB.
- File System Access API integration for folder picker.
- XMP sidecar write-out (canonical serializer + passthrough buckets).
- Deploy to static hosting (Cloudflare Pages / Netlify / Vercel).
