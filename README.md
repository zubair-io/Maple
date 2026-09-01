# Maple

A professional, non-destructive RAW photo editor and library by Just Maple. One Rust image-processing core drives every surface:

| Surface                                                 | Where it lives       | How it reaches the core                        |
| ------------------------------------------------------- | -------------------- | ---------------------------------------------- |
| **Maple Exposure** — macOS, iPadOS, iOS (Swift/SwiftUI) | `src/apple/`         | `RawPipeline.xcframework` built from `raw-ffi` |
| **Maple TV** — tvOS light-table viewer                  | `src/apple/Maple TV` | Same xcframework                               |
| **Web app `maple`** — served by the API (Self Hosted)   | `src/web/`           | `raw-wasm` (WebAssembly + WebGPU)              |
| **Web app `maple-syrup`** — Maple Hosted, browser-only  | `src/web/`           | `raw-wasm`                                     |
| **API + Indexer** — Bun, Elysia, MongoDB                | `src/api/`           | `libmaple_core` dylib via `bun:ffi`            |
| **Windows shell** — Rust host + WinUI 3                 | `src/windows/`       | `raw-ffi` / `raw-gpu` linked directly          |
| **Thumbnail edge cache** — Cloudflare Worker + R2       | `src/cloudflare/`    | Fronts the API's thumbnail route               |

Every edit is non-destructive and lives in an `.xmp` sidecar next to the original; originals are never modified. The pipeline is scene-referred (linear Rec.2020 D65, f32) with a single view transform at the end of the chain. Colour correctness is gated in CI by a perceptual (CIEDE2000) harness against Adobe Camera Raw references, and slider response is budgeted at one 60 Hz frame on a 100 MP RAW.

## Repository layout

```
src/
  raw-pipeline/   Rust workspace: raw-core, raw-gpu, raw-ffi, raw-wasm, maple-cli, maple-pano, codegen
  apple/          Xcode project, app + extension targets, local packages (MapleCore, MapleUI, MapleBackup)
  web/            Angular workspace: maple, maple-syrup, maple-common; Playwright e2e; Storybook
  api/            Bun + Elysia server, MongoDB schema, indexer and enrichment workers, job runner
  windows/        maple-windows crate + Maple.WinUI (C#) + tests
  cloudflare/     Thumbnail-cache Worker
  scripts/        Colour/pano/search harnesses, image-diff metrics, dev-self-hosted.sh
tools/            File-size budget gates, codegen.sh, Maple UI contract check, calibration helpers
test-fixtures/    RAWs are gitignored; ACR references, budgets, and parity corpora are committed
docs/             Architecture and reference docs — start at docs/README.md
```

## Quick start

**Rust core** (stable toolchain; `rustfmt` + `clippy` components):

```bash
cd src/raw-pipeline && cargo test -p raw-core --lib
```

```bash
cd src/raw-pipeline && cargo build --release -p maple-cli
```

**Apple** (Xcode; build the gitignored static libs once, then build the scheme):

```bash
./src/apple/scripts/build-xcframework.sh
```

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=macOS' build
```

**Web** (Bun or npm; the `prestart` hook builds and syncs the WASM package):

```bash
cd src/web && bun install && bun run start:syrup
```

**Self Hosted stack** (MongoDB in Docker on 27017, API on 3000, Angular dev server on 4201, all from the repo root):

```bash
npm run dev
```

**API alone:**

```bash
cd src/api && bun install && bun run dev
```

## Reference renderer — `maple-cli`

The Rust workspace ships a deterministic headless CLI that renders, batches, diffs, and inspects RAWs exactly the way the apps do. It is the reference every platform pipeline is compared against.

```bash
src/raw-pipeline/target/release/maple-cli render --out out.png --params edits.xmp photo.dng
```

```bash
src/raw-pipeline/target/release/maple-cli batch --out-dir candidates/ test-fixtures/references/manifest.json
```

```bash
src/raw-pipeline/target/release/maple-cli diff --budget 5 candidate.png reference.png
```

```bash
src/raw-pipeline/target/release/maple-cli inspect photo.dng
```

Further subcommands cover panorama stitching, tile rendering, embedded-preview extraction, auto tone and auto adjustments, synthetic fixtures, ACR curve fitting, film-look packs, and DCP transcoding; run `maple-cli --help` or see [docs/pipeline.md](docs/pipeline.md).

The colour gate that CI runs is `src/scripts/test_color_pipeline.sh`; per-case ceilings live in `test-fixtures/budgets.json` and only ratchet downward. See [docs/testing.md](docs/testing.md).

## Documentation

| Read this                                                                                                                  | When you need to…                                                |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [docs/README.md](docs/README.md)                                                                                           | Find anything — the index                                        |
| [docs/architecture.md](docs/architecture.md)                                                                               | Understand the deploy units and how the core reaches each        |
| [docs/features.md](docs/features.md)                                                                                       | Know what the product does today, per platform                   |
| [docs/pipeline.md](docs/pipeline.md)                                                                                       | Change a decode, develop, or view-transform stage                |
| [docs/xmp-canonical-format.md](docs/xmp-canonical-format.md)                                                               | Touch the sidecar schema                                         |
| [docs/apple.md](docs/apple.md), [docs/web.md](docs/web.md), [docs/api.md](docs/api.md), [docs/windows.md](docs/windows.md) | Work inside one platform                                         |
| [docs/indexer-enrichment.md](docs/indexer-enrichment.md)                                                                   | Add or change a worker stage                                     |
| [docs/caching.md](docs/caching.md)                                                                                         | Add or invalidate a cache                                        |
| [docs/testing.md](docs/testing.md)                                                                                         | Run or add a gate                                                |
| [docs/best-practices.md](docs/best-practices.md)                                                                           | Match house style in Rust, Swift, Angular, or the API            |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                                                                         | Commit rules, file-size budgets, tooling, PR flow                |
| [CLAUDE.md](CLAUDE.md)                                                                                                     | Working agreements for AI agents and the load-bearing invariants |

## Contributing

Work is tracked in GitHub Issues on two project boards, **Files** (feature work) and **KTLO** (hygiene, bugs, refactors). Every PR closes a ticket, uses Conventional Commits, and lands via "Rebase and merge" on a linear branch. Install the pre-commit hooks once per clone:

```bash
brew install lefthook && lefthook install
```
