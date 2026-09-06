# Maple documentation

Every document in this directory describes the code as it is in the tree today. Nothing here is a plan, a ticket, or a status report: work to do lives in GitHub Issues (Files and KTLO project boards), and design history lives in git. If a doc and the code disagree, the code is right and the doc is a bug — fix it in the same PR.

## Start here

| Doc                                              | Read it to…                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)               | See every deploy unit, how the one Rust core reaches each of them, the data model, the two-phase render, and the codegen single-sourcing.                   |
| [features.md](features.md)                       | Know what the product does today, surface by surface, with a per-platform matrix of what ships where.                                                       |
| [best-practices.md](best-practices.md)           | Match house style in Rust, Swift/SwiftUI, Angular, and the Bun API before you write code.                                                                   |
| [testing.md](testing.md)                         | Run or add a gate: every CI workflow, every harness script, the colour budget ratchet, and the fixture setup.                                               |
| [capability-registry.md](capability-registry.md) | **Generated** — every editor capability's `core` / `integrated` / `released` state, computed from the qualification evidence on disk.                       |
| [camera-support.md](camera-support.md)           | **Generated** — every camera body's `qualified` / `profiled` / `matrix-only` / `decode-only` / `unsupported` tier and its lens axis, computed the same way. |

[Export recipes and batch delivery](export-recipes.md) documents saved recipes, supported encoders, Web/Windows/CLI/API consumers, and recovery.

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

## Design system

| Doc                                                          | Covers                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [unified-component-catalog.md](unified-component-catalog.md) | The Maple UI catalog: every atom, molecule, and organism with its web / Apple / Windows implementation status.                                                                |
| [design/maple-ui/components/](design/maple-ui/components/)   | One contract per component. These files are load-bearing: `tools/check-maple-ui-contracts.sh` lints them in CI and `maple-syrup` serves them on its `/maple-ui` gallery page. |
| [design/responsive-program/](design/responsive-program/)     | The responsive web program's per-surface design notes (phone shell, grid, loupe, editor, inspector, search, settings) and the tool-glyph sheets that source comments cite.    |

## Strategy

`docs/strategy/milestones/` is the one deliberate exception to "no plans, tickets, or status" below: forward-looking milestone design specs that a GitHub epic and its sub-issues cite by path, describing intended work rather than the code as it stands today.

| Doc                                                                                                    | Covers                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [strategy/milestones/m1-release-contract.md](strategy/milestones/m1-release-contract.md)               | Milestone 13 · Release Contract & Qualification: per-ticket scope, sequencing, and open decisions.                                                                                     |
| [strategy/milestones/m2-global-workflow.md](strategy/milestones/m2-global-workflow.md)                 | Milestone 14 · Complete Global Editing Workflow (epic #2444): sampled/preset white balance, the lens resolver, batch sync, variants/snapshots/history, and export recipes.             |
| [strategy/milestones/m3-local-adjustments.md](strategy/milestones/m3-local-adjustments.md)             | Milestone 15 · Local Adjustments & Repair: the masking cluster and the Local AI Inpainting epic, sequencing, and open decisions.                                                       |
| [strategy/milestones/m3-skin-tone-vectorscope.md](strategy/milestones/m3-skin-tone-vectorscope.md)     | Milestone 15 slice: the skin-tone vectorscope, the person skin mask, the per-mask hue control, and the GPU scope statistic that feeds the scope without a pixel readback, macOS first. |
| [strategy/milestones/m4-color-output.md](strategy/milestones/m4-color-output.md)                       | Milestone 16 · Color & Output Qualification: the C0–C5 evidence suite, the camera/lens support-tier registry, and the Neutral/Camera Match/Auto Tone/Auto Look rendering modes.        |
| [strategy/milestones/m5-workflow-expansion.md](strategy/milestones/m5-workflow-expansion.md)           | Milestone 17 · Professional Workflow Expansion (epic #2447/#2442): the decision framework for choosing the next adjacent professional workflow from evidence.                          |
| [strategy/milestones/m6-native-to-web-editor-ui.md](strategy/milestones/m6-native-to-web-editor-ui.md) | Milestone 18 design spec: the editor surface/interaction parity manifest, the IA port, the command router, and the acceptance gates that bring the web editor to native-editor parity. |

## Conventions for editing these docs

- Derive from code, cite paths. Name the file that implements a mechanism; never cite line numbers.
- No plans, tickets, or status. If it is work to do, open an issue.
- Keep the filenames stable. Source comments cite `architecture.md`, `best-practices.md`, `caching.md`, `indexer-enrichment.md`, `xmp-canonical-format.md`, `zoom.md`, and the component contracts by path.
- Markdown is formatted by Prettier with the repo config (`src/web/.prettierrc`); `bun run format` in `src/web` fixes the files a branch changes.
