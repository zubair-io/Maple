# Tickets 10 (H/I/J) + 12 — Parallel Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. This is a coordination plan, not a per-task TDD plan — each agent receives the relevant ticket excerpt as its spec.

**Goal:** Resolve all 13 open items across Ticket 10 items H/I/J and Ticket 12's bug list (10 items) in a single parallel sweep.

**Architecture:** 7 agents dispatched in parallel, each in its own git worktree (isolation). Each owns a non-overlapping file set so they can work without coordination. Integration is sequential after all branches return — branches are reviewed and merged one at a time.

**Tech Stack:** Swift / SwiftUI (Apple shell), Angular + WebGL2 (Web), Rust core (unchanged for this batch).

---

## Conflict / file-ownership map

| Agent | Items | Primary files (exclusive ownership) |
|-------|-------|--------------------------------------|
| A1 | Bugs 4, 5, 8 | `src/apple/Maple/Views/DetailPanel.swift`, plus the `mode` flip in `AppShell.swift` (read-only on AppShell, edit only the tab-state bridge) |
| A2 | Bugs 1, 7 | `src/apple/Maple/Views/AppShell.swift` (split-view widths only), `src/apple/Maple/Views/BrowseGrid.swift` |
| A3 | Bug 2 | `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` (+ adjacent kernel wiring), `src/web/projects/maple-common/src/lib/components/image-canvas/image-canvas.component.ts` (+ webgl chain) |
| A4 | Bug 6, Tic 10-J | `src/apple/Packages/MapleCore/Sources/MapleCore/ImageMetadataReader.swift`, the Info-tab subview inside `DetailPanel.swift` (Info section only — A1 owns tab-switching state), `EditSession.swift:752` (one-line call-site swap) |
| A5 | Bug 3, Tic 10-I, Tic 10-H | `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` (everything except line 752), `src/apple/Maple/Views/FullImageView.swift`, `src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift` |
| A6 | Bug 9 | `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/PhotoKitSource.swift`, `PhotoKitLibrary.swift`, library-sidebar wiring in `AppShell.swift` (read-only — coordinate with A2 if writes needed) |
| A7 | Bug 10 | `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/SMBSource.swift`, `SMBCredentialStore.swift` |

**Known overlap risks:**
- `AppShell.swift` is touched by A2 (widths), potentially read by A1 / A6. A2 owns writes; A1 and A6 may only read.
- `DetailPanel.swift` is touched by A1 (tab state) and A4 (Info subview). Each works in a distinct subview block — should not collide on edit but verify on integration.
- `EditSession.swift` is touched by A4 (one line at 752) and A5 (multiple ranges). Lines are far apart — non-conflicting.

## Reference materials per agent

- A6 + A7 must consult the sibling reference repo at `../Maple` (i.e. `/Users/riabuz/Projects/Maple/`) for the working version of PhotoKit and SMB code paths. The bug notes call this out explicitly.
- All Apple agents must run `./src/apple/scripts/build-xcframework.sh` first IF the Frameworks/RawPipeline.xcframework slices are missing (gitignored). Most aren't touching Rust, so a stale framework is fine — just don't rebuild unnecessarily.

## Verification per agent

| Agent | Build / test command |
|-------|----------------------|
| A1 | `xcodebuild -project src/apple/Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build` + manual: open editor, verify tab flips on full-image enter / browse return, Develop hidden in Browse |
| A2 | macOS + iPad simulator build, manual: iPad detail panel narrow, folder requires double-click |
| A3 | macOS + Web build (`bun x ng serve maple`), manual: every slider produces visible canvas change |
| A4 | `cd src/apple/Packages/MapleCore && swift test` + macOS build, manual: PhotoKit asset paints (Info tab shows full EXIF) |
| A5 | `cd src/apple/Packages/MapleCore && swift test` + macOS build, manual: open with no sidecar applies sharpen=45/radius=5; CanvasMath used in fit + zoom; rapid slider doesn't double-render |
| A6 | macOS build, manual: All Photos / Favorites loads in library sidebar (compare vs `../Maple`) |
| A7 | macOS build, manual: SMB connect → folder list populates (compare vs `../Maple`) |

## Integration order (after all worktrees return)

1. **A2** (Browse navigation) — smallest, isolated.
2. **A1** (DetailPanel tabs) — small, isolated to DetailPanel.
3. **A4** (Metadata + sourceless) — DetailPanel Info subview + ImageMetadataReader + 1-line EditSession.
4. **A5** (EditSession trio) — large EditSession changes; conflicts with A4's 1-line edit are resolvable.
5. **A6** (PhotoKit) — depends on A4's sourceless variant being merged for assets to actually paint.
6. **A7** (SMB) — independent.
7. **A3** (Slider regression) — biggest, last so any other regressions surface against a known-good state.

Each merge: `git merge <agent-branch> --no-ff`, run macOS build, fix conflicts, commit.

---

## Self-review notes

- All items in Ticket 10 (H/I/J) covered → A5 (H, I), A4 (J).
- All 10 items in Ticket 12 covered → A2 (1, 7), A3 (2), A5 (3 via AdjustmentModel.default override), A1 (4, 5, 8), A4 (6), A6 (9), A7 (10).
- No item appears under two agents.
- Type / call-site consistency: only cross-agent dependency is A4's `ImageMetadataReader.readPixelSize(from data: Data)` signature, which A6 may consume after A4 merges.

## Integration outcome (2026-04-26)

All 7 worktrees merged into `main`. Order: A1, A4, A7 (auto-landed via worktree cleanup), then merge commits for A2, A5, A6, A3.

Conflicts resolved during merge:
- `AppShell.swift` detail block (A1+A2): kept A1's `isFullImage:` arg + A2's `DetailPanelWidth` modifier.
- `FullImageView.swift` near line 145 (A5): A5's branch was older than `8a94d47` (canvas debug print removal); kept HEAD's removal and dropped the now-unused `let scale = effectivePixelScale(...)` line.

`xcodebuild -scheme Maple -destination 'platform=macOS' build` → **BUILD SUCCEEDED** post-merge.

`swift test` post-merge: 193 tests, 3 skipped, 3 failures:
1. `DeepZoomTileRenderingTests.testTileManagerUpdateMissReturnsEmptyComposite` — pre-existing on main HEAD, unrelated.
2. `SceneLinearPipelineTests.testSpikeAgXMatchesRustReferenceWithLUT` — pre-existing on main HEAD, unrelated (Ticket 09 territory).
3. `SceneLinearVisualRegressionTests.testRenderTest_0017_defaultMatchesGolden` — **expected** post-merge: the golden at `src/apple/MapleUITests/Goldens/test_0017-default.png` was recorded before A3's transposed-matrix fix and A5's `sharpen=45/radius=5` default. Both are intentional product changes; the OLD golden represents the buggy state. **Re-record path:** delete the PNG, re-run `swift test --filter SceneLinearVisualRegressionTests`, eyeball the new baseline, commit. Surfaced for user decision rather than auto-re-recorded.

Worktrees retained at `/Users/riabuz/Projects/_Maple/.claude/worktrees/agent-{a2b40308,a6fb7270,a9b328fe,ab626b03}/` for spot-check; clean up with `git worktree remove ...` once verified.

Manual GUI verification still owed (none of the agents could click through the live app):
- Bugs 4/5/8 (A1): tab flips on full-image enter / browse return; Develop hidden in Browse.
- Bug 1 (A2): iPad detail pane is now narrow.
- Bug 2 (A3): every slider produces a visible canvas update on Mac and Web.
- Bug 9 (A6): All Photos / Favorites populates the grid (after granting Photos permission).
- Bug 10 (A7): SMB connect → folder list populates (needs a real NAS share).
