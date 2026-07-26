# Contributing to Maple

A short engineering contract. The longer story lives in `CLAUDE.md`, `docs/feature-spec.md`, `docs/ui-spec.md`, and `docs/best-practices.md`.

> **Doc paths assume PR #204 (the `docs/` rename sweep) has merged.** Before that lands, the live filenames on `main` are `docs/photo-app-feature-spec.md`, `docs/photo-app-ui-spec.md`, and `docs/photo-app-mockup.html`. This file uses the post-rename names so we don't need a follow-up doc edit.

## The load-bearing rules

These are invariants. If you're about to violate one, stop and ask.

1. **Non-destructive only.** Original files are never modified. All edits go to `.xmp` sidecars. The sidecar is the contract; the pixels are derived. No migration tools, cleanup utilities, or "tidy up" passes that touch user assets. Originals are sacred.
2. **Scene-referred pipeline.** The working space is linear Rec.2020 D65 at f32. Exposure is a linear multiply. A single view transform at the end of the chain compresses scene range into display range. Nothing before the view transform clips.
3. **One Rust core, three native pipelines.** Color math (decode, demosaic, calibration, LUT generation, dehaze, deconvolution) lives in `src/raw-pipeline/raw-core`. That crate compiles once as a static library for Apple (via C-FFI) and once as WebAssembly for browsers. Platform GPU paths (Metal, WebGL2) are idiomatic on each platform but gated against the Rust reference. No hand-mirrored matrices — constants flow through `src/scripts/codegen/`.
4. **Parity before features.** Pixel parity between Apple and Web is a merge gate, not an aspiration. See `docs/testing.md`.
5. **Performance is a product feature.** Slider tick must produce a new preview inside 16ms (50ms hard limit) on the reference scene set. No allocation inside the render loop, no per-tick round-trip across the WASM boundary.

## File-size budget

- **Soft limit:** 400 lines. Warned by `tools/check-file-budget.sh` and by lefthook on commit. Encouraged to split, not blocked.
- **Headroom limit:** 570 lines. On a PR, `tools/check-budget-headroom.sh` fails if your change _grows_ a source file past this. Files already above it are fine as long as you don't make them bigger — shrinking always passes.
- **Hard limit:** 600 lines. Blocks commit / CI unless the path is in `tools/budget-allowlist.txt`.

The headroom limit exists because the hard limit alone punishes the wrong PR (#2311). Splitting a file to clear 600 naturally lands it at 598 or 599, since that's the cheapest change that turns CI green — and then the next unrelated PR adding two lines is the one that fails. On 2026-07-25 that took `main` red: one PR left `raw-pipeline.service.ts` at 599, the next added 19 (#2266). **So when you split a file, split it with real margin** — aim well under 570, not just under 600.

The allowlist is the day-0 audit of historical violators (#113). Every entry maps to a split ticket on the KTLO project board, and the allowlist is append-forbidden in CI (#114). When you split a file, remove its allowlist entry in the same PR. Allowlisted paths are exempt from the headroom check too.

To check locally:

```bash
bash tools/check-file-budget.sh                  # whole repo
bash tools/check-file-budget.sh path/to/file.ts  # one file
bash tools/check-file-budget.sh --help
```

```bash
bash tools/check-budget-headroom.sh origin/main  # what the PR gate runs
bash tools/check-budget-headroom.sh --self-test  # exercise the checker itself
```

## Task tracking

- All work is tracked in GitHub Issues, on one of two project boards: **Files** (feature work) or **KTLO** (hygiene, bugs, refactors).
- No markdown ticket sprawl in `docs/`. If a doc is read-only reference, it stays in `docs/`; if it's work-to-do, it's an issue.
- **Every PR closes a ticket.** Before starting work, ensure an issue exists; if not, open one (`gh issue create`) and tag it to the right board (`gh issue edit <N> --add-project "Files"` or `KTLO`). Every PR description must include a `Closes #N` (or `Fixes #N`) line so the ticket auto-closes on merge. No drive-by PRs without a ticket.

## Commits and pull requests

- **Conventional Commits** for the first line: `type(scope)?: description`. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Enforced by the `commit-msg` hook in `lefthook.yml`.
- **Squash-merge only.** No merge commits on `main`.
- **No `--amend` after pushing.** Make a new commit; the diff in review is the diff that lands.
- **No `--no-verify`.** If the hook fails, fix it. The hook is the contract.
- PR body: one-line summary, a short "why" paragraph, and a `Closes #N` line. Include a test plan when the change isn't covered by an existing harness.

## Tooling

| When        | What runs                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| editor-save | Format-on-save via your editor's prettier / rustfmt / swift-format / ruff integration                                                                                       |
| pre-commit  | `lefthook.yml` — file-budget + prettier + rustfmt + swift-format + ruff + shfmt on staged files (graceful skip)                                                             |
| commit-msg  | `lefthook.yml` — Conventional Commits regex check on the first line                                                                                                         |
| CI          | `.github/workflows/api.yml` runs API tests. Cross-cutting `cross.yml`: prettier format-check on changed files, file budget, codegen drift, gitleaks, allowlist-shrinks-only |
| weekly      | (planned) parity-budget ratchet sweep                                                                                                                                       |

Install lefthook once per clone:

```bash
brew install lefthook          # or: npm i -g lefthook
lefthook install               # writes .git/hooks/*
```

If a formatter binary isn't installed locally, the corresponding pre-commit step soft-skips with a one-line notice. CI is the actual gate — local hooks are the early-warning system.

## Per-language formatter + lint

| Language          | Format                                             | Lint                | Config                                                             |
| ----------------- | -------------------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| TypeScript / HTML | `prettier --check` (printWidth 100, single quotes) | — (none configured) | `src/web/.prettierrc`                                              |
| Rust              | `rustfmt --edition 2021`                           | `cargo clippy`      | repo defaults (no `rustfmt.toml` yet)                              |
| Swift             | `xcrun swift-format lint --strict`                 | (same)              | repo defaults (no `.swift-format` yet — Xcode bundled config used) |
| Python            | `ruff format --check`                              | `ruff check`        | repo defaults (no `pyproject.toml` yet)                            |
| Shell             | `shfmt -d`                                         | `shellcheck` (CI)   | repo defaults                                                      |

`rustfmt.toml`, `.swift-format`, and `pyproject.toml` will land alongside the first formatter run that needs non-default settings — kept lean until a real reason appears.

## Vendored Rust dependencies

The Rust workspace's crate sources are vendored into `src/raw-pipeline/vendor/` so the **Apple xcframework build** never resolves or downloads from `static.crates.io`. That build runs on Xcode Cloud, where transient DNS failures (`Could not resolve host: static.crates.io`) intermittently kill TestFlight builds; vendoring makes it hermetic and reproducible.

The source replacement is **not** a committed `.cargo/config.toml` (which every cargo invocation under `src/raw-pipeline/` would inherit). Instead `build-xcframework.sh` passes it inline, scoped to the `raw-ffi` build only:

```sh
cargo build --offline \
  --config 'source.crates-io.replace-with="vendored-sources"' \
  --config 'source.vendored-sources.directory="…/vendor"' \
  --package raw-ffi --target <apple-triple>
```

Scoping matters: the WASM build (`raw-wasm/build.sh`) uses `-Z build-std`, which rebuilds `std` from source and needs `std`'s own dependency versions — those aren't in our vendor dir, so a repo-level replacement would break it. The web/wasm and API builds keep resolving from crates.io as before; only the Apple build is hermetic. `--offline` means a stale or incomplete vendor dir fails loudly rather than silently hitting the network.

`vendor/` is committed source (≈22 MB packed; marked `linguist-vendored` so it stays out of language stats). `vendor/.gitignore` (`!*`) overrides the repo's top-level ignores so the tree is committed in full — without it the root `target/` rule silently drops the `cc` crate's `src/target/` module, and cargo's checksum step then fails on a fresh clone. **Re-vendor whenever dependencies change** — after `cargo update`, adding, or removing a crate:

```bash
cd src/raw-pipeline
cargo vendor vendor          # regenerates vendor/ from Cargo.lock
git add vendor Cargo.lock
# Guard against a partial tree — fails loudly if any vendored file is ignored.
git status --ignored --short vendor | grep -q '^!!' \
  && { echo 'DROPPED FILES — fix vendor/.gitignore'; exit 1; } \
  || echo 'vendor tree complete'
```

Commit the `Cargo.lock` change and the regenerated `vendor/` together. Verify before pushing:

```bash
cargo build --offline \
  --config 'source.crates-io.replace-with="vendored-sources"' \
  --config "source.vendored-sources.directory=\"$PWD/vendor\"" \
  -p raw-ffi
```

## Layout

```
src/
  apple/               Swift app (Mac, iOS, iPad) — SPM-based
  raw-pipeline/        Rust core (cargo workspace) — raw-core, raw-ffi, raw-wasm, maple-cli
  web/                 Angular 21 workspace — projects/maple, projects/maple-common
  api/                 Bun + Elysia + MongoDB (Self Hosted backend + indexer)
  scripts/             Bash + Python harness scripts (color-pipeline, codegen, dev)
docs/                  Specs, architecture, best practices (read these before editing)
tools/                 Repo-wide tooling — file-budget, calibration, sanity checks
test-fixtures/         Gitignored RAWs + ACR references + per-case budgets
```

## Testing

- **No mocks for the sidecar layer.** Round-trip against real `.xmp` files in a temp directory. XMP is the contract; mocks let bugs through.
- **One shared `test-fixtures/`.** Apple, Rust, and Web all read the same RAWs and ACR references. Fixtures are gitignored; harnesses skip-pass when absent so CI doesn't fail spuriously on a clone without `test-fixtures/raws/`.
- **Color correctness is not eyeballed.** `src/scripts/test_color_pipeline.sh` is the canonical perceptual gate (CIEDE2000 vs ACR). Per-case budgets in `test-fixtures/budgets.json` are a one-way ratchet — they only go down, in the same commit that delivers the improvement.
- **16ms slider budget.** No feature ships that breaks the slider-tick budget on the reference scene set. If a feature adds allocation inside the render loop or a per-tick WASM round-trip, it does not ship.
- **Apple visual harness** lives in `src/apple/MapleUITests/`; **slider matrix harness** is `SliderMatrixUITests` (see `CLAUDE.md` § "UITest visual harness").

## Storybook (web)

The Angular workspace ships a Storybook instance under
`src/web/.storybook/` for developing UI primitives in isolation against
stub stores. Stories live next to their components as
`*.stories.ts` files and are picked up automatically by the
`projects/**/*.stories.@(ts|mdx)` glob in `.storybook/main.ts`.

```bash
cd src/web

# Dev server on http://localhost:6006 (live reload on story changes).
bun run storybook

# Static export — produces `src/web/storybook-static/` for CI / preview deploys.
bun run build-storybook
```

Both scripts proxy to `ng run maple:storybook` and `ng run maple:build-storybook`,
configured in `src/web/angular.json`.

Notes for an Angular 21 + multi-project workspace:

- The Storybook architect targets are attached to the `maple` project but
  pick up stories from every project under `projects/`. Stories in the
  `maple-common` library are excluded from the `ng-packagr` library build
  via `tsconfig.lib.json`'s `exclude` glob, so they don't ship to consumers.
- The Storybook config deliberately does NOT set `browserTarget` — pulling
  in `projects/maple/src/main.ts` drags the WASM-backed raw-pipeline into
  the Angular type-checker, which fails when the gitignored wasm-pack
  artifacts are absent. Global styles are wired through the `styles`
  option on the architect target instead.
- The `.storybook/tsconfig.json` is intentionally narrow — it includes only
  `preview.ts` and `*.stories.ts` and lets transitive imports pull in the
  components under test. Don't widen it to `src/**` without good reason.

### Authoring stories

Every reusable / screen-level component should have a sibling
`*.stories.ts`. Use Component Story Format 3 (typed `Meta` + `StoryObj`
from `@storybook/angular`). Each story file should at minimum cover:

- `Default` — the most common props
- `Loading` / `Empty` / `Error` / `EdgeCases` — when applicable

Stub services via `moduleMetadata` providers when a component pulls in
shared state; the seed stories in this PR avoid that surface deliberately
(they target leaf primitives — `MapleButton`, `MapleCollapsible`,
`LoadingBanner`, `ErrorBanner`).

## Read before editing

| If you need to…                           | Read this                                        |
| ----------------------------------------- | ------------------------------------------------ |
| Decide what a feature should do           | `docs/feature-spec.md`                           |
| Decide how a screen should look or behave | `docs/ui-spec.md`                                |
| Pick a pattern for an Angular component   | `docs/best-practices.md` § "Angular"             |
| Pick a pattern for a Swift view           | `docs/best-practices.md` § "Swift"               |
| Change the XMP schema                     | `docs/sidecar-schema.md`                         |
| Touch a color-pipeline stage              | `docs/architecture.md` + `docs/testing.md`       |
| Add a cache                               | `docs/caching.md`                                |
| Understand the build matrix               | `CLAUDE.md` § "Build & test — Apple / Web / API" |

## Bundle ID

`app.justmaple.aperture` (tests append `.Tests` / `.UITests`). Don't rename.
