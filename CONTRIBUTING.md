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
- **Hard limit:** 600 lines. Blocks commit / CI unless the path is in `tools/budget-allowlist.txt`.

The allowlist is the day-0 audit of historical violators (#113). Every entry maps to a split ticket on the KTLO project board, and the allowlist is append-forbidden in CI (#114). When you split a file, remove its allowlist entry in the same PR.

To check locally:

```bash
bash tools/check-file-budget.sh                  # whole repo
bash tools/check-file-budget.sh path/to/file.ts  # one file
bash tools/check-file-budget.sh --help
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

| When        | What runs                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| editor-save | Format-on-save via your editor's prettier / rustfmt / swift-format / ruff integration                                |
| pre-commit  | `lefthook.yml` — file-budget + prettier + rustfmt + swift-format + ruff + shfmt on staged files (graceful skip)      |
| commit-msg  | `lefthook.yml` — Conventional Commits regex check on the first line                                                  |
| CI          | `.github/workflows/api.yml` runs API tests. Cross-cutting `cross.yml` (lint + budget + parity gates) tracked in #114 |
| weekly      | (planned) parity-budget ratchet sweep                                                                                |

Install lefthook once per clone:

```bash
brew install lefthook          # or: npm i -g lefthook
lefthook install               # writes .git/hooks/*
```

If a formatter binary isn't installed locally, the corresponding pre-commit step soft-skips with a one-line notice. CI is the actual gate — local hooks are the early-warning system.

## Per-language formatter + lint

| Language          | Format                                              | Lint                | Config                                                                  |
| ----------------- | --------------------------------------------------- | ------------------- | ----------------------------------------------------------------------- |
| TypeScript / HTML | `prettier --check` (printWidth 100, single quotes)  | `ng lint` (web only)| `src/web/.prettierrc`                                                   |
| Rust              | `rustfmt --edition 2021`                            | `cargo clippy`      | repo defaults (no `rustfmt.toml` yet)                                   |
| Swift             | `xcrun swift-format lint --strict`                  | (same)              | repo defaults (no `.swift-format` yet — Xcode bundled config used)      |
| Python            | `ruff format --check`                               | `ruff check`        | repo defaults (no `pyproject.toml` yet)                                 |
| Shell             | `shfmt -d`                                          | `shellcheck` (CI)   | repo defaults                                                           |

`rustfmt.toml`, `.swift-format`, and `pyproject.toml` will land alongside the first formatter run that needs non-default settings — kept lean until a real reason appears.

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

## Read before editing

| If you need to…                           | Read this                                          |
| ----------------------------------------- | -------------------------------------------------- |
| Decide what a feature should do           | `docs/feature-spec.md`                             |
| Decide how a screen should look or behave | `docs/ui-spec.md`                                  |
| Pick a pattern for an Angular component   | `docs/best-practices.md` § "Angular"               |
| Pick a pattern for a Swift view           | `docs/best-practices.md` § "Swift"                 |
| Change the XMP schema                     | `docs/sidecar-schema.md`                           |
| Touch a color-pipeline stage              | `docs/architecture.md` + `docs/testing.md`         |
| Add a cache                               | `docs/caching.md`                                  |
| Understand the build matrix               | `CLAUDE.md` § "Build & test — Apple / Web / API"   |

## Bundle ID

`app.justmaple.aperture` (tests append `.Tests` / `.UITests`). Don't rename.
