# Maple File Provider — Phase 6 Design (hardening + iOS verification)

**Status:** draft, 2026-05-17
**Prior phases:**
- `docs/superpowers/plans/2026-05-14-file-provider-phase1.md` — local mirror + manual refresh
- `docs/superpowers/specs/2026-05-16-file-provider-phase2-design.md` — XMP write-back + conflict reconciliation
- `docs/superpowers/specs/2026-05-16-file-provider-phase3-design.md` — uploads + soft delete
- `docs/superpowers/specs/2026-05-16-file-provider-phase4-design.md` — iOS full mirror
- `docs/superpowers/specs/2026-05-16-file-provider-phase5-design.md` — Quick Look + working set + ETag

## Goal

Close the concrete gaps that Phase 5 review surfaced and explicitly deferred,
plus the iOS perf verification that Phase 4 shipped without. Nothing
speculative — every item below has a code reference, a review comment, or a
plan-doc note pointing at it.

## Scope

In:

1. **ETag in-memory cache LRU bound** on `RemoteCatalog.etagCache`.
2. **Change-feed payload carries `relativePath`** so working-set stubs can
   resolve their actual folder parent and the OS can route invalidation
   precisely instead of always falling back to `.workingSet`.
3. **Cross-process cursor durability** for `ChangeCursorStore` — replace the
   `UserDefaults` + in-process `NSLock` with an `atomic` file write under the
   App Group container so the host app and the extension cannot stomp each
   other.
4. **Quick Look thumb disk cache** in the QL extension, keyed on the same
   ETag the server returns, so spacebar across N files doesn't pay N
   round-trips.
5. **iOS perf budget verification** — real-device measurement of the working
   set's cold-open + first-enumeration on iPhone 16 Pro (the device class
   Phase 4 targeted but never measured).

Out (deferred — explicit, with reason):

- **Mongo change stream replacing the 500 ms tailer.** Push-shaped is better
  than poll, but requires a replica set in production. The current 500 ms
  tailer is correct and within latency budget for an editor; revisit when a
  replica set lands.
- **Smart-folder virtual containers beyond Trash** — same reason as Phase 5.
- **Quick Look on iOS** — Phase 5a scaffolded the appex for macOS only. iOS
  Quick Look has its own provider protocol; revisit after Phase 6's iOS
  perf work tells us whether it's wanted.
- **Working-set list cache TTL.** Currently invalidates every 50 events
  (Phase 5b). No evidence the fixed cadence is wrong; defer until profiling
  produces a number.

## Non-goals

- New features. Phase 6 is sweeper work — no surface area that didn't already
  ship.
- Backwards compat shims. There are no production users; behaviour changes
  land directly.

## Detail per item

### 1. ETag cache LRU

`src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift`
holds `etagCache: [String: ETagEntry]` unbounded. A Finder spacebar-walk
through a 10k-asset folder pins ~1 GB of `Data` in the extension. Audit doc
at `docs/superpowers/notes/2026-05-17-file-provider-phase5c-perf-audit.md`
calls this out.

**Acceptance:** insertions beyond N (suggest N = 256 entries) evict the
least-recently-used entry. Test: insert 257 entries, assert the first one is
gone, the last 256 survive.

### 2. `relativePath` in change-feed payload

Server side: `recordAssetChange` already has `absPath`. Extend the persisted
row + the SSE event payload with `relativePath` (path relative to the
matching library root) and `folderID`. Schema migration is a one-way
extension — old rows just get `null`, the client tolerates it.

Apple side: `MapleItem.stubAssetID` currently parents every change-event item
under `.workingSet`. Once the payload carries `folderID` + `relativePath`,
construct a proper `folder(folderID, relativePath).item(...)` identifier.
`FileProviderExtension.handleChangeEvent` can also derive the parent folder
identifier and signal that specific enumerator instead of (or in addition to)
`.workingSet`, closing the "nested folder views stay stale" review comment
that Phase 5b only partially addressed.

**Acceptance:** add an asset under a non-root folder, observe the change
event in the Apple extension carries the right `folderID`, observe the
constructed item has the correct parent. The Finder view of that subfolder
updates without a manual refresh.

### 3. Atomic cross-process cursor store

`src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/ChangeCursorStore.swift`
uses App Group `UserDefaults` with an `NSLock` to protect the
read-modify-write. The lock only covers same-process. The host app and the
extension can both load, both decide they're the higher cursor, and both
write — the second write wins regardless of which was actually newer. The
existing code comment acknowledges this residual TOCTOU window.

Fix: replace with `Data.write(to:, options: .atomic)` against a small file
under the App Group container. On every write, read the current file value,
take `max(old, new)`, write atomically. POSIX `rename` semantics give us the
cross-process atomicity that UserDefaults doesn't.

**Acceptance:** simulate two processes racing — one writes cursor 100, the
other simultaneously writes cursor 50, the file contains 100 regardless of
which call returned first. Add a stress test that loops 1000 writes from two
queues and asserts monotonicity.

### 4. Quick Look thumb disk cache

`MapleQuickLook.appex` currently calls `RemoteCatalog.getThumb(assetID:)`
which uses the in-memory ETag cache. Across sessions, every spacebar press
re-fetches. Add a `~/Library/Group Containers/<group>/QuickLookThumbs/`
disk cache keyed by `(assetID, etag)`. On hit + matching ETag → serve from
disk. On hit + missing/different ETag → fetch with `If-None-Match`, get 304
or fresh bytes, update disk.

Eviction: time-based (entries > 7 days drop on next read) plus a size cap
(e.g. 200 MB). LRU is overkill; bounded TTL covers it.

**Acceptance:** spacebar a fixture twice across separate extension sessions,
second hit reads from disk (no network), confirmed by capturing logs.

### 5. iOS perf verification

Phase 4 shipped iOS full-library mirror but the perf invariants in CLAUDE.md
(16 ms slider tick, 250–1000 ms cold open) were never measured on real iOS
hardware. The iOS xcframework slice is arm64-only today (so the simulator
isn't representative).

Run on an iPhone 16 Pro:
- Cold-launch the FP extension against a 10k-asset domain. Capture time to
  first `enumerateItems` response.
- Re-enumerate after each of 50 simulated SSE events. Capture wall-clock per
  event + memory high-water.
- Quick Look thumb fetch on 100 sequential assets. Capture latency
  distribution.

**Acceptance:** numbers land within the CLAUDE.md budget envelope, OR we
have a concrete list of items missing the budget and a written plan for
each. No "directionally fine" — actual numbers, a `docs/superpowers/notes/`
file with the table.

## Test/parity expectations

Each item gets unit/integration coverage where the surface allows. Item 5 is
inherently manual — its deliverable is the measured-numbers note, not a unit
test. The existing Phase 5 perf-audit doc framing applies: numbers in, or
explicit `PERF_BASELINES_UNAVAILABLE`.

## Out of scope (revisit triggers)

- Mongo change stream tailer: revisit when production deploys a replica set.
- iOS Quick Look: revisit after item 5 produces real numbers on whether
  spacebar-in-Files is a desired workflow.
- Smart folders / virtual containers beyond Trash: revisit when product
  feedback says the OS-favourite path is insufficient.

## Implementation order

Items 1, 2, 3 are independent and can be parallelized. Item 4 builds on item
1 (shares the eviction shape) — sequence it after. Item 5 is independent of
all of them; can run first if device access is the blocker, or last if
budget is tight.
