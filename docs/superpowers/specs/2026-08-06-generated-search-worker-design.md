# Generated Search Worker — design

Status: draft, pending review
Date: 2026-08-06

## Problem

Maple has 300k+ assets and no way to rediscover them. The Light Table on Maple
TV approximates this with three hardcoded queries (picks, high-rated, recent
photos-with-faces), but the collections never change and never surprise anyone.

We want a worker that invents a handful of themed collections every day —
"Spooky Nights", "Seven Summers of Lake George" — that the Apple widget, the
Maple TV timeline, and the Settings → Workers page can cycle through. The point
of regenerating daily is that the themes are _not_ deterministic: the operator
reads what the model came up with, and that reading is part of the product.

## Scope

This spec covers **deliverable 1 only**: the generator worker and the read API
that exposes its output. Three consumers follow in their own specs, against the
contract defined here:

2. Settings → Workers surface (list today's collections, click through to `/search`)
3. Maple TV timeline shelf
4. Apple WidgetKit extension (no widget target exists on Apple today)

## Key insight: `placeQuery` is already semantic search

The first design routed the LLM through a vocabulary dictionary — aggregate the
library's `vision.subjects` / `activity` / `notable_objects`, put the list in the
prompt, have the model pick from it. That was solving a problem this repo has
already solved.

`GET /api/search` with `placeQuery` routes through Meilisearch with
`semantic: meili.semanticConfigured()` (`routes/search/list-meili.ts:84`), and
the embedder template (`enrichment/meilisearch-embedder-template.ts:78`) embeds
the full caption prose alongside people, place, transcript and OCR at a 5000-byte
budget. So `placeQuery=children in halloween costumes with jack-o-lanterns`
matches captions that share no keywords with it.

The model therefore writes **natural-language scene descriptions**, not dictionary
lookups. Structured params survive only for the axes where exact filtering is
genuinely correct: dates, named people, scene type.

**Dependency:** semantic defaults to **off** (`meilisearch-client.ts:141`) and
needs vector coverage over the library. The generator reads `semanticConfigured()`
and coverage at run start and switches prompt mode:

- semantic on → "describe the scene you want to see"
- semantic off → "use literal nouns that would appear in a caption"

With semantic off the feature still works, but themes land more bluntly. Turning
semantic on is effectively a prerequisite for this being _good_.

## Architecture: title comes after the query, not before

The naive shape — ask the model for `{theme, title, subtitle, query}` in one
call — produces titles that misrepresent their own queries, and **no result-count
check can catch it**. Observed in probing (2026-08-06, `gemma4:12b`):

```
title:    "Memories of August 6th"
subtitle: "Looking back at every year's favorite moments from this day."
query:    { from: "2017-08-04", to: "2017-08-08" }   <- 2017 alone
```

That returns plenty of photos. It passes any floor. It is still a lie. Likewise
"Seven Summers of Lake George" whose query carried neither a date range nor Lake
George.

So the generator runs in three phases and names a collection after what is
actually in it:

**Phase 1 — propose.** The model emits `theme` + `query` only. No title. Grounded
by the digest (below) and constrained by a JSON Schema passed to Ollama's `format`
parameter, so it cannot emit a key outside the whitelist.

**Phase 2 — execute.** The worker runs each query through the _same_ `buildFilter`
that `/api/search` uses, and collects the result count plus a sample of ~10
captions. Queries under the floor (default 8 results) go back to phase 1 with a
machine-generated miss reason ("returned 2 photos", "`from` predates the library").
Two retry rounds, then whatever cleared the floor survives.

**Phase 3 — title.** The model receives the sampled captions and writes `title` +
`subtitle` for a collection it can actually see. Title-lies become structurally
impossible rather than something we ask the model to avoid.

This also plays to model strengths — see "Model choice".

## The digest

One aggregation per run. Much smaller than the dictionary approach, because the
model no longer does vocabulary lookup — it only needs what it cannot infer:

```
TODAY: Thursday, 6 August 2026
PEOPLE (only these names exist): Ana, Sam, Mia, Theo, Priya
PLACES: Albany NY, Lake George NY, Portland ME, Montreal, Cape Cod MA
COVERAGE
  photos by year: 2016(1.2k) ... 2026(4.4k)
  photos near Aug 6 (+/-3 days), by year: 2017(88) 2019(142) 2023(203)
SEARCH MODE: semantic | lexical
THEMES USED IN THE LAST 14 DAYS (do not repeat): autumn colours, dogs at the lake
```

`PEOPLE` is built from non-hidden people only. This is stronger than filtering
hidden people's photos out afterward — the model never learns they exist, so it
cannot theme on them in the first place.

## The model's surface

Exactly five fields. Everything else is appended server-side at execution time,
so there is no key for the model to set them with:

| Model-settable                       | Server-forced               |
| ------------------------------------ | --------------------------- |
| `placeQuery` (natural language)      | `libraryId`                 |
| `from` / `to` (YYYY-MM-DD)           | `excludeHiddenPeople: true` |
| `people` (CSV, verbatim from digest) | `isScreenshot: false`       |
| `sceneType` (enum)                   | hidden-image default        |

`rating` is deliberately **excluded**. It filters `$gte` (`routes/search/query.ts:290`),
and a model volunteered `rating: 1` unprompted during probing, which would have
excluded every unrated photo in the library.

`excludeHiddenPeople` is forced at _execution_ time, not stamped at generation
time, so a stored doc can never leak hidden people even if written by an earlier
version.

## Data model

New `generated_searches` collection:

```
{ _id, library_id,
  generated_for: "2026-10-31",   // the day this run targeted
  generated_at, model, attempts,
  theme, title, subtitle,
  query: { placeQuery, from, to, people, sceneType },
  result_count, cover_asset_id }
```

Retained ~30 days so the settings page shows history, pruned by the same worker.

## Where it lives

A **maintenance job** (`workers/generated-search/`), wired into
`workers/maintenance.ts` beside trash-gc, dedupe, and mirror-scan — not a
`workers/stages/` stage. Stages are strictly per-asset; this is library-wide
periodic work.

Config lives in `worker_config` (interval, collections-per-day, result floor,
retry budget, model), surfaced on `/settings/workers` — not environment
variables. Starts paused until Ollama is configured, following `geocode`'s
`pausedOnFirstBoot` precedent.

## Read API

- `GET /api/generated-searches?libraryId=&date=` — the day's collections
- `GET /api/generated-searches/:id/assets` — runs the stored query and returns results

Both consumers (widget, TV) call the second, so query semantics live in one place
and cannot drift between surfaces.

## Ollama integration

Reuse the describe provider (`enrichment/describe-providers/ollama.ts`), never a
hand-rolled fetch. Under a `format` schema constraint, a thinking model's grammar
blocks its `</think>` terminator and Ollama returns the entire JSON in `thinking`
with an empty `response`. This is **per-model**: observed on `ornith:35b`, not on
`gemma4:12b`. The provider already carries the fallback (#2172).

Two further prompt constraints learned from probing:

- **No concrete examples in the instruction text.** A model returned "Running
  Through Sprinklers" — lifted verbatim from the prompt's own illustrative example.
- **Assign each collection a distinct axis structurally** (a date range, a person,
  a place, a kind of scene) rather than asking for variety in prose. Asked
  politely, one model applied one identical date window to three of four
  collections.

## Model choice

One run each, 2026-08-06, same prompt:

|                            | `ornith:35b`   | `gemma4:12b`                                                |
| -------------------------- | -------------- | ----------------------------------------------------------- |
| Place names verbatim       | 5/5            | dropped "Lake George", invented "the nearby lake and woods" |
| Dates inside real coverage | yes            | `from: 2013-06-01` (library starts 2016)                    |
| `placeQuery` prose         | terse keywords | rich scene descriptions                                     |
| `subtitle`                 | always null    | always written                                              |
| Latency                    | 15.1s          | 12.9s                                                       |

Suggests `ornith:35b` for phase 1 (grounding) and `gemma4:12b` for phase 3
(prose). Both configurable. **This is one sample per model — run 5–10 before
locking the defaults.**

## Testing

- Pure unit tests for the phase-1 output validator (fixtures, no Mongo), mirroring
  `routes/search/hidden-people.test.ts`.
- An explicit test that a stored query containing `excludeHiddenPeople: 'false'`
  still executes with it forced on.
- A test that hidden people's names never appear in the digest.
- Real-Mongo integration test for the three-phase loop with a stubbed Ollama,
  following the existing describe-provider stubbing pattern. Covers: floor
  rejection, retry-then-succeed, retry-exhausted (fewer collections saved than
  requested), and prune-after-30-days.
- An operator-facing dry-run path that prints proposed queries and their result
  counts without persisting, so prompt changes can be evaluated against the real
  library.

## Open questions

1. **Is semantic search enabled on the deployed install?** If not, this ships
   degraded until vectors are backfilled. Blocking for quality, not for build.
2. **Does the library have real IPTC `keywords`?** They are user-authored and the
   highest-signal theme vocabulary available, and are currently unreachable by any
   search path (not in `search_blob`, not a Meili attribute, no query param).
   Own ticket if the bags are populated; drop entirely if not.
3. Collections per day, and whether the widget cycles within one collection or
   across all of them.

## Deferred

- `vision.mood` / `vision.colors` into `search_blob`. Mood words already leak
  through caption prose; making them reliable is a nice-to-have, not a blocker.
- IPTC keywords (see open question 2).
- Feeding the TV Light Table from generated collections instead of its three
  hardcoded queries — natural follow-on, out of scope here.
- Verify a possible drift: `composeSearchBlob` folds in vision
  subjects/setting/activity/notable_objects/transcript, but
  `searchBlobUpdateExpression` (used by `db/assets.repo.ts`, `db/client.ts`)
  unions only place + description + ocr + people.
