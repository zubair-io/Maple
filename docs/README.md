# Maple documentation

Every document in this directory describes the code as it is in the tree today. Nothing here is a plan, a ticket, or a status report: work to do lives in GitHub Issues (Files and KTLO project boards), and design history lives in git. If a doc and the code disagree, the code is right and the doc is a bug — fix it in the same PR.

## Start here

| Doc                                    | Read it to…                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)     | See every deploy unit, how the one Rust core reaches each of them, the data model, the two-phase render, and the codegen single-sourcing. |
| [features.md](features.md)             | Know what the product does today, surface by surface, with a per-platform matrix of what ships where.                                     |
| [best-practices.md](best-practices.md) | Match house style in Rust, Swift/SwiftUI, Angular, and the Bun API before you write code.                                                 |
| [testing.md](testing.md)               | Run or add a gate: every CI workflow, every harness script, the colour budget ratchet, and the fixture setup.                             |

## Core and pipeline

| Doc                                                | Covers                                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [pipeline.md](pipeline.md)                         | The Rust workspace: decode, the develop chain stage by stage, colour management, the view transform, the wgpu/WGSL GPU path, FFI and WASM surfaces, `maple-cli`, codegen, the pipeline output version. |
| [xmp-canonical-format.md](xmp-canonical-format.md) | The sidecar contract shared by the Rust, Swift, TypeScript, and C# implementations: namespaces, byte-canonical form, every field, tone curves, passthrough, versioning, and the round-trip tests.      |
| [zoom.md](zoom.md)                                 | The shared `pixelScale` zoom model, fast/refine render targets, the native-detail tile path, and the gated deep-zoom tile compositor.                                                                  |
| [pano.md](pano.md)                                 | Panorama stitching in `maple-pano`: stages, ONNX models, the C ABI, and how Apple and the server drive it.                                                                                             |
| [caching.md](caching.md)                           | Every cache on every platform, what keys it, and what invalidates it, including the `.maple/` folder cache shared across devices.                                                                      |

## Platforms

| Doc                                            | Covers                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [apple.md](apple.md)                           | The Xcode project, every target and extension, the three local packages, the xcframework build, the render path, sources, and the UI test harnesses.                 |
| [web.md](web.md)                               | The Angular workspace: the `maple` and `maple-syrup` apps, `maple-common`, the render worker, WASM build and sync, service worker, tests, deployment.                |
| [api.md](api.md)                               | The Bun + Elysia server: process model, MongoDB collections, auth, library addressing, filesystem layout, native FFI, Cloudflare, Meilisearch, settings, operations. |
| [server-api.md](server-api.md)                 | The HTTP route reference, generated from the route sources with auth tier and parameters.                                                                            |
| [indexer-enrichment.md](indexer-enrichment.md) | The discover sweep, the stage runner, every registered stage, the job runner, search indexing, and face clustering.                                                  |
| [windows.md](windows.md)                       | The WinUI 3 shell, its P/Invoke surface onto the Rust core, File Explorer integration, tests, and CI.                                                                |

## Strategy

| Doc                                                                                          | Covers                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [strategy/milestones/m5-workflow-expansion.md](strategy/milestones/m5-workflow-expansion.md) | The decision framework for milestone 17 (#2447/#2442): how the next adjacent professional workflow gets chosen from evidence, not a feature checklist. |

## Design system

| Doc                                                          | Covers                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [unified-component-catalog.md](unified-component-catalog.md) | The Maple UI catalog: every atom, molecule, and organism with its web / Apple / Windows implementation status.                                                                |
| [design/maple-ui/components/](design/maple-ui/components/)   | One contract per component. These files are load-bearing: `tools/check-maple-ui-contracts.sh` lints them in CI and `maple-syrup` serves them on its `/maple-ui` gallery page. |
| [design/responsive-program/](design/responsive-program/)     | The responsive web program's per-surface design notes (phone shell, grid, loupe, editor, inspector, search, settings) and the tool-glyph sheets that source comments cite.    |

## Conventions for editing these docs

- Derive from code, cite paths. Name the file that implements a mechanism; never cite line numbers.
- No plans, tickets, or status. If it is work to do, open an issue.
- Keep the filenames stable. Source comments cite `architecture.md`, `best-practices.md`, `caching.md`, `indexer-enrichment.md`, `xmp-canonical-format.md`, `zoom.md`, and the component contracts by path.
- Markdown is formatted by Prettier with the repo config (`src/web/.prettierrc`); `bun run format` in `src/web` fixes the files a branch changes.
