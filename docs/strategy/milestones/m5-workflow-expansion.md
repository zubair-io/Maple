# M5 — Professional Workflow Expansion: a decision framework

`docs/strategy/milestones/` numbers its docs M1–M6, mapping to GitHub milestones
13–18 in order: M1 → milestone 13, M2 → 14, M3 → 15, M4 → 16, M5 → 17, M6 → 18.
This doc is M5, i.e. milestone 17.

This is not a feature design. Milestone 17 (Professional Workflow Expansion,
epic #2447) and its scoping ticket #2442 ask for one thing: pick a single
adjacent professional workflow to build next, from evidence about what
blocks a real cohort of qualified users, and write that choice down before
any implementation issue exists. This document is the framework that
produces that choice — the criteria, the current evidence picture, the
candidates it applies to, and the record the owner fills out. It is
deliberately the smallest possible spec for the smallest possible milestone:
a decision, not a build.

## 1. Outcome

A "next workflow" gets chosen by scoring named candidates against a fixed
set of criteria, using whatever real evidence exists, and recording the
result — not by a feature-comparison checklist against other editors, and
not by picking whatever has the most GitHub reactions.

The lifecycle:

1. Score each candidate (§3) against the criteria in §4, using the evidence
   available today — which, as §2 lays out, is entirely qualitative right
   now (issue engagement, support and sales conversations), because Maple
   ships no in-product usage analytics.
2. If that qualitative evidence can't distinguish the candidates with
   confidence, the recommended move is a bounded, opt-in telemetry pass —
   coarse event counters for just the areas the leading candidates would
   serve, run for a few weeks, then torn back down (§2, §5-Q1).
3. The owner fills out one decision record (§4) naming the selected cohort,
   the blocked job, the scores, and which candidates are explicitly
   rejected or deferred and why.
4. #2442's acceptance criteria gate that record: milestones 1–4 (bug
   burn-down, sidecar/metadata integrity, editor completion, masking &
   local adjustments — all closed) are the entry bar: the core non-destructive
   editor has to be solid before Maple spends a milestone widening scope.
   The record also needs success, support, security, and abort thresholds,
   and a statement of how the workflow disables cleanly.
5. Only after the record is approved do implementation issues get created,
   scoped as their own milestone-sized epic — the same shape Photo Map
   (#2824) and the panorama track (milestone 08) took, just made deliberate
   instead of ad hoc.

Non-goals, carried over from #2442: no simultaneous launch of multiple
candidate tracks, and no scoring based on product age, reputation, or
raw feature-count parity with competing tools.

## 2. Current state

### What Maple already does

`docs/features.md` is the source of truth; the relevant summary for this
decision is that everything Maple ships today is core photography
management, not an adjacent professional workflow:

| Area            | What exists                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Ingest          | Local/SMB/PhotoKit/server sources, plus server-side import that copies a folder into a library (never a live tether)  |
| Cull & organize | Ratings, flags, color labels, keywords; grid, timeline, unified search, map, people clustering                        |
| Develop         | One shared adjustment model, film-look LUTs, presets, AUTO/reset/copy-paste                                           |
| Deliver         | Single-asset export only (JPEG/TIFF/PNG, sRGB/P3); a server `batch_jpeg_export` job exists but no client UI drives it |
| Backup          | Apple-only PhotoKit → server backup                                                                                   |
| Panorama        | Frame merge via `maple-pano`, off until an operator provisions ONNX models                                            |

None of this is tethered capture, client review/delivery, print
proofing, automation/API access, or specialized display workflows — the
categories #2442 names as candidate tracks.

### What evidence sources exist today

Be direct about this: **Maple has no product usage analytics.** There is
no counter anywhere for how often the editor's tools are touched, how many
exports happen per format, how many pano stitches complete, or how many
sessions a given surface sees. The only always-on telemetry is
OpenTelemetry tracing and log shipping to SigNoz (`src/api/src/otel.ts`,
config in `src/api/src/observability/observability-config.repo.ts`,
follow-up gaps tracked in #2196). That pipe is infrastructure health, not
product evidence: HTTP and MongoDB spans, crash stack tails, and structured
logs, aimed at "is the server working," not "which feature do qualified
users actually use." It is operator-configured (DB-backed, off until an
endpoint is set — `Settings → Observability`), and metrics are plumbed but
deliberately left unwired (`otel.ts`'s own comment: "there's no metrics
exporter today").

The generated-search worker (`src/api/src/workers/generated-search/`) was
also worth ruling out explicitly: it builds home-screen "on this day" /
"recent trip" style collections from a nightly digest of the library, not
usage signals about the product itself.

So the only evidence that exists today is qualitative: GitHub issue and PR
engagement (reactions, comments, duplicate reports pointing at the same
gap), and whatever support or sales conversations the owner has had
directly. That's real evidence, but it is biased toward whoever is loud on
GitHub, not toward the qualified cohort #2442 asks for.

### What would need instrumenting, if the decision is to measure first

If §5-Q1 resolves toward measuring before choosing, the shape should be:

- Coarse, named event counters per candidate job — e.g. "export dialog
  opened," "batch metadata sheet used," "pano stitch completed" — counts
  and timestamps only, never file paths, filenames, people, or place data.
- An opt-in toggle, DB-backed and surfaced on a settings page per CLAUDE.md's
  settings convention (no new env var). The natural home is extending
  `Settings → Observability` with a product-usage category, since that page
  is already the trust boundary users understand for "does telemetry leave
  this deployment."
- Riding the existing OTel pipe as a metrics signal instead of standing up
  a second collection path — `otel.ts` already has the metrics flag
  plumbed through, just unwired.
- A hard, bounded collection window (a few weeks), not a permanent feature —
  this is a decision-support measurement, not a shipped analytics product.

## 3. Candidates

Mapped from #2442's named tracks onto the concrete tickets that currently
exist for them. Ticket numbers link to the acceptance criteria; "M1–4
dependency" notes whether the closed foundational milestones already cover
what the candidate would build on.

| Candidate                                     | Ticket(s)                                               | Segment                                                                 | Gap today                                                                                                                                                                       | Rough effort | M1–4 dependency                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Tethered capture                              | none (Imports wizard PR #2884 is adjacent but distinct) | Studio/event shooters tethering a camera to a laptop mid-session        | #2884 ships post-shoot folder import; there is no live-capture listener anywhere in the codebase — tethering would be new protocol/vendor-SDK work, not an extension of imports | L–XL         | Needs the import path's dest-folder and sidecar-pairing logic (already built), but the capture listener itself is greenfield                |
| Batch export recipes                          | #2438 (M14, open)                                       | Anyone delivering multiple images — client galleries, contact sheets    | Export is single-asset on every front end today; a server `batch_jpeg_export` job exists with no client UI                                                                      | XL           | Depends on the stable adjustment model and export color chain (M1–4 territory, done); already scoped as its own M14 epic                    |
| Variants & snapshots                          | #2437 (M14, open)                                       | Photographers exploring alternate treatments for client selects         | One sidecar per asset today; no branching or checkpointing model                                                                                                                | XL           | Depends on the sidecar schema being stable (M2, closed); already scoped as its own M14 epic                                                 |
| Soft proofing / gamut warning                 | #1697 (Icebox, low priority)                            | Print-delivery photographers                                            | No ICC target preview or gamut-warning overlay; the view transform ends at Rec.2020/P3/sRGB display only                                                                        | L            | Self-contained addition to the view-transform tail; doesn't require reopening the develop chain                                             |
| HDR/EDR display output                        | #1702 (Icebox, low priority)                            | Photographers reviewing or delivering on XDR/HDR displays               | Display tail clamps to SDR everywhere; no `CAMetalLayer` EDR wiring on Apple, no HDR canvas color-space handling on web                                                         | L            | Touches the GPU display path on both platforms — needs raw-gpu WGSL parity per CLAUDE.md's "one GPU chain" rule, not just a CPU-side change |
| Multi-frame video description                 | #2158 (M10, already high priority)                      | Video-heavy libraries — event/wedding shooters mixing photo and video   | Today one caption per video (poster frame only); no per-scene description over time                                                                                             | L            | Mostly reuse of the existing describe stack; already moving on its own track — see the note below                                           |
| Automation SDK                                | named in #2442, no ticket yet                           | Pro/enterprise users wanting scripted or DAM-integrated pipeline access | `maple-cli` and the FFI surfaces exist internally; there is no documented public API/SDK contract                                                                               | Unscoped     | Needs its own scoping spike before it can be scored meaningfully (§5-Q4)                                                                    |
| Additional native surface / print integration | named in #2442, no ticket yet                           | Unclear until defined                                                   | No specific gap has been written down yet                                                                                                                                       | Unscoped     | Needs a concrete candidate definition before it enters scoring                                                                              |

Photo Map (#2824, done) and the panorama track (milestone 08) are useful
reference points, not candidates: both were adjacent-workflow expansions
that shipped without this framework existing, each built around one clear
user-facing gap and a bounded scope. This document formalizes retroactively
what worked about them.

A note on #2158: it already carries `priority:high` inside its own
milestone (10 · Maple TV & video) and is mostly a reuse of infrastructure
that already exists. Scoring it inside the M17 decision would let it win by
default on low cost rather than on cohort priority against the other
tracks — the recommendation in §5-Q5 is to exclude it from this round and
let it proceed on its own track.

## 4. Decision record

### Criteria

Score every real candidate (one with a defined cohort and gap) against:

- **Cohort size and qualification** — how many current or reachable users
  are qualified professionals blocked by this job, and what do they already
  need (hardware, network, an existing habit) to hit the gap.
- **Job frequency and severity** — how often the blocked job comes up, and
  how bad the workaround is today (leaves Maple entirely vs. tolerable
  friction).
- **Retention or revenue impact** — does solving this keep a cohort that
  would otherwise churn to a competing tool, or unlock one that wouldn't
  adopt Maple at all.
- **Ownership-model fit** — does the workflow keep Maple's non-destructive,
  self-hosted, no-lock-in posture, or does it require a service dependency
  that undercuts it.
- **Ongoing support burden** — what does this cost the team every week
  after ship, not just to build.
- **Qualification cost** — what a user must already have set up before this
  workflow is usable to them at all.
- **Reversible pilot cost** — can the workflow ship behind a flag, run a
  pilot, and be turned back off without corrupting sidecars or original
  assets, per the epic's own exit criteria.

Explicitly excluded from scoring, per #2442's non-goals: product age,
reputation, and feature-count parity with other editors.

### Template

```
Candidate:
Cohort definition:
Blocked job (one sentence):
Evidence (source + date, one line each):
Scores (1–5, one line per criterion in §4):
Alternatives rejected or deferred (one line each, with reason):
Pilot scope:
Pilot success metric:
Abort threshold:
Security / privacy / support sign-off:
Reversibility statement (how it disables cleanly):
```

The record is the deliverable of #2442's second acceptance criterion. It
gets attached to the epic before any implementation issue is opened, and
implementation issues cite it the way every Maple PR cites a ticket.

## 5. Open decisions for the owner

1. **Instrument usage before choosing, or decide from today's qualitative
   evidence?** Recommended default: run the bounded, opt-in telemetry pass
   described in §2 before finalizing the record. The current evidence is
   entirely GitHub engagement and anecdote, which is biased toward whoever
   is loudest, and #2442's own acceptance criteria require the named
   cohort to be "supported by usage evidence" — a bar today's tooling
   can't actually clear.
2. **Where does the opt-in toggle live if instrumentation happens?**
   Recommended default: extend `Settings → Observability` rather than add a
   new settings page — it is already the trust boundary users understand
   for "telemetry leaves this deployment," and it already has the DB-backed
   config pattern this needs.
3. **Who compiles the qualitative evidence (support tickets, sales
   conversations) if instrumentation is deferred or the window isn't
   enough?** Recommended default: the product owner fills the record's
   Evidence field by hand from existing channels; this doesn't need new
   tooling, just discipline about citing a source and date per line.
4. **Does the automation SDK candidate get scored this round without a
   ticket?** Recommended default: no — mark it "insufficiently scoped" in
   the record and revisit in a follow-up decision once its cohort and
   effort are actually written down, rather than blocking this round on
   writing that ticket now.
5. **Does #2158 (video description) compete in this decision?**
   Recommended default: exclude it — it is already prioritized and moving
   inside milestone 10 on its own, and including it here would let it win
   on low incremental cost rather than genuine cohort priority against the
   other candidates.
6. **What's the pilot's blast radius?** One deployment, a small opt-in beta
   cohort, or every Self Hosted instance at once. Recommended default: an
   opt-in beta flag reaching a small cohort first, consistent with the
   "reversible pilot cost" criterion and the existing pattern of
   pause/resume on new backend stages.
