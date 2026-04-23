# maple-hosted — Production Angular Workspace

Browser-only Maple photo editor. No server, no account, no database. The full RAW pipeline runs in the browser via WebAssembly (`raw-wasm`). See `docs/spec/00-overview.md` and `docs/spec/12-maple-apps-spec.md` § 06.

## Workspace structure

This directory is an **Angular workspace** with two projects — a unified SPA and a shared library:

```
angular.json            workspace configuration
package.json            npm dependencies
tsconfig*.json          TypeScript configurations
ngsw-config.json        Service worker asset manifest
DEPLOY.md               Production deploy instructions (Cloudflare / Netlify / Vercel / Apache / nginx)
projects/
  maple/                Unified SPA — serves /browse and /edit/:id via Angular Router
  maple-common/         Shared library: models, services, components, shells, XMP pipeline
_design-reference/      React-via-CDN prototype (visual/interaction reference — NOT production)
```

### What's in `maple-common`

All UI components and domain logic live here and are tree-shaken into the `maple` bundle:

- **Shells**: `BrowseShellComponent`, `EditorShellComponent`
- **Browse components**: `FolderTreeComponent`, `AssetGridComponent`, `BrowseDetailPanelComponent`, `DropZoneComponent`
- **Editor components**: `FilmstripComponent`, `ImageCanvasComponent`, `EditorDetailPanelComponent`, `ImageCanvasService`
- **Develop panel**: `ToneSectionComponent`, `WhiteBalanceSectionComponent`, `PresenceSectionComponent`, `SharpeningSectionComponent`, `NoiseSectionComponent`, `EditorSliderComponent`, `WbPresetPillsComponent`
- **Scopes**: `HistogramComponent`, `WaveformComponent`, `ParadeComponent`, `VectorscopeComponent`, `ScopesContainerComponent`
- **Services**: `LibraryStateService`, `RawPipelineService`, `FolderAccessService`, `MapleCacheService`, `XmpStoreService`, `ImageCanvasService`
- **Models**: `Asset`, `AdjustmentModel`, `SidebarEntry`, `MapleFolderHandle`
- **XMP pipeline**: parser, serializer, store (debounced sidecar writes)

## Angular dev server

```bash
cd src/maple-hosted
npm install
ng serve maple          # serves the full SPA at http://localhost:4200/
# browse at /browse, editor at /edit/:id — same port, same app
```

Or via npm scripts:

```bash
npm start               # npm run sync-raw-wasm && ng serve maple --port 4200
```

## Build

```bash
ng build maple --configuration=production
# or:
npm run build           # same thing; also runs sync-raw-wasm
```

Output: `dist/maple/browser/` with hash-named bundles, `raw_wasm_bg.wasm`, `ngsw-worker.js`, `ngsw.json`, `manifest.webmanifest`.

## Deploy

See `DEPLOY.md` for per-host instructions covering:

- **Cloudflare Pages** — SPA fallback, WASM MIME type, build command
- **Netlify** — `netlify.toml` with redirect + header stanzas
- **Vercel** — `vercel.json` with filesystem + fallback routes
- **Apache / nginx** — `.htaccess` rewrite rules and nginx server block

## View the React prototype (design reference)

The `_design-reference/` subdirectory contains the Claude Design handoff — a self-contained HTML/JSX React app that demonstrates the Coral Maple UI with pixel accuracy. Use it as a visual and interaction reference.

```bash
cd _design-reference
python3 -m http.server 8000
# open http://localhost:8000/
```

Open `_design-reference/Spec.html` for the full interaction spec that accompanied the design handoff.
