# File Provider Phase 5c — Perf audit (Mode B)

**Status:** `PERF_BASELINES_UNAVAILABLE` — captured per the plan's "Mode B" branch.
The audit and baselines defined in plan Tasks 7–9 require a live macOS desktop
session with Finder, a populated Maple API server, and an enrolled File Provider
domain. None of those are available in this execution environment, so we record
the **shape** of what would be measured and the suspected hotspots that the
post-change profile would inspect. We do NOT fabricate numbers — any concrete
ms/MB figures in a future PR description must come from a real Instruments run.

This file is intentionally committed (the plan files it under
`.archived-plans/notes/` and leaves the .gitignore decision to the executor;
keeping it in-repo lets the next agent or live-environment owner pick the audit
back up without re-deriving the suspect list).

---

## What 5c shipped

1. Body-hash `ETag` + `If-None-Match` on `/api/folders`, `/api/fs/dir`,
   `/api/assets/:id/thumb`, `/api/fs/thumb` (tasks 1–4, already merged).
2. In-memory ETag cache in `RemoteCatalog` so the client transparently
   re-uses the decoded payload on a 304 (task 5, already merged).
3. Disk-primed `LibraryRootCache` actor with a background revalidation
   path and a drift signal that re-enumerates the root container when
   the fresh folder list differs from what was just served (task 6,
   this PR).

The three optimisations target the cold-Finder-open and warm-refresh
paths the spec calls out. They are additive caching with explicit
unit-test coverage; nothing in them depends on a profiler signal.

## What a live audit would inspect

Per plan Task 7 step 5, the goal is to identify any per-tick allocation
> 1 MB or any single function > 50 ms inside a per-enumeration / per-
spacebar / per-refresh call path. With the ETag work in place, the
profile shape should change as follows:

| Scenario             | Before (expected hot)              | After (expected delta)            |
| -------------------- | ---------------------------------- | --------------------------------- |
| Cold Finder open     | `/api/folders` decode + N folder enumerations | One decode of folders (priming disk) + per-folder decodes only on first traversal |
| Warm Refresh         | Full re-decode of every body       | All 304s, zero body decode, ETag-cache `Data`/`[Decodable]` lookups only |
| Spacebar (cold)      | Thumb download + JPEG decode       | Same path as before — thumb endpoint is the bottleneck and is now ETag-cached but the first hit still streams bytes |
| Spacebar (warm)      | Same as cold in current code       | 304 reply, served from RemoteCatalog's in-memory thumb cache |

## Suspected hotspots a live profile would scrutinize

These are stated as suspects, not confirmed findings. No optimisation
should ship here until a profile shows it pays off (the plan's "out of
scope" section is explicit).

1. **`JSONDecoder().decode(...)` on large `DirContents`** — a folder
   with thousands of images produces a multi-MB JSON body. A single
   decode is fine; doing it per-tick because of a missing ETag would
   not be. With 5c's `RemoteCatalog` ETag cache, this should now decode
   exactly once per `(URL, body)` pair. Verify via Time Profiler that
   `JSONDecoder.decode` does not dominate any per-refresh sample.

2. **`MapleItem` allocation per page** — `FolderEnumerator` builds one
   `MapleItem` per child. Phase 4 server-side pagination is referenced
   in the plan (Task 8), but `RemoteCatalog.listDir` does not currently
   take a `cursor` parameter (verified by grep) — pagination follow-
   through is a future-phase concern. For now, the entire page is
   delivered in one `didEnumerate` call; the allocation cost scales
   with page size but the allocator does not recurse.

3. **`Data` retention in the thumb ETag cache** — `RemoteCatalog` keeps
   the full thumb bytes alongside their ETag, one entry per asset URL.
   A photographer previewing thousands of thumbs in a session could
   accumulate hundreds of MB. The 5c PR explicitly calls this out as a
   risk; the size-bounded LRU is deferred to Phase 6.

4. **`String(data:, encoding:)` of response bodies** — anywhere the
   client decodes a body via an intermediate `String`, the body lives
   twice in memory. Spot-check the catalog's helpers; if any do this,
   switch to direct `JSONDecoder.decode(_:, from: Data)` (which most
   already do, judging by the codebase pattern).

5. **`OSSignposter` overhead** — plan Task 7 step 1 adds
   `os_signpost` brackets around `enumerateItems` and `fetchContents`.
   These are cheap (~hundreds of ns) and the spec calls for them, but
   we defer landing the signposts until a live-environment agent can
   run the profile that actually consumes them. Adding them blind
   without a profile run is just noise in the source.

## How a future agent would convert this to Mode A

1. Stand up the API server with a populated MongoDB (≥ 50 library
   roots, ≥ one folder with ≥ 500 assets).
2. Enable the FP domain on a Mac that has Maple installed.
3. Run plan Task 0 (cold-Finder-open, warm-Refresh, spacebar cold/hot)
   on the pre-5c branch — capture an Instruments trace per scenario.
4. Apply 5c, repeat. Diff the metrics, paste into the PR description.
5. For any single function > 50 ms or any per-tick allocation > 1 MB
   that the profile flags, open a follow-up plan-step in this file
   with the concrete intervention. Land each intervention as its own
   commit with the before/after numbers in the commit body.

## Mode B marker

This document IS the authoritative `PERF_BASELINES_UNAVAILABLE`
declaration for the 5c PR. The PR description should reference this
file rather than embed a redundant marker; if the PR carries no marker
and no link to this audit, treat the perf numbers as unavailable by
default. The 5c optimisations rely on design rigour (additive ETag
caching + disk priming with unit-test coverage) and not on a measured
delta.

To convert this branch to Mode A, follow "How a future agent would
convert this to Mode A" above and replace this section with a table
of before/after numbers from the Instruments runs.
