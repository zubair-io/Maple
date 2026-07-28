# Hybrid Asset Ranking — Transcript as First-Class Evidence (#2384)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transcript text a dedicated, explicitly-labelled field in Maple's Meilisearch asset document and embedding template, so transcript-rich videos rank on their actual spoken content instead of being flattened into an alphabetised token bag.

**Architecture:** Today one Mongo-side field, `search_blob`, is the only home for transcript text, and it is a **lowercased, deduped, alphabetically-sorted bag of tokens** (`search-blob.ts:53-85`). That bag is then the first and largest input to the managed embedder template (`{{ doc.searchBlob }} {{ doc.description }} {{ doc.people }}`). We add discrete `transcript` / `placeText` fields to the Meilisearch document, replace the template with a labelled non-duplicating one, reorder searchable attributes so named people and transcript are high-weight evidence, and make vector-coverage invalidation correct across a document-shape change. Measurement lands as a committed relevance corpus with Recall@10 / MRR budgets, mirroring the color harness convention.

**Tech Stack:** Bun + Elysia + MongoDB (`src/api`), Meilisearch v1 sidecar over bare `fetch`, Ollama `bge-m3` embedder, `bun test`.

## Global Constraints

- **Preserve the user query verbatim.** No rewriting, expanding, paraphrasing, stemming, or synonym injection of `HVAC air conditioning installation` (or any query) anywhere between the route body and Meilisearch. The only normalisation that exists today is `request.query.trim()` in `service-asset-search.ts:266`; it stays and nothing is added. Ranking gains must come from document representation, field weighting, blend tuning, or candidate reranking. Task 5 adds the enforcing assertion.
- **File-size budget:** SOFT 400 LOC (warn), HARD 600 LOC (blocks CI). `tools/budget-allowlist.txt` is append-forbidden. `meilisearch-client.ts` is at **568 lines** — only 32 lines of headroom. Task 1 extracts code out of it before anything else grows it. Run `tools/check-file-budget.sh src/api/src` before every commit.
- **Two document writers must stay in lockstep:** the per-asset stage (`src/api/src/workers/stages/meili.ts` → `meilisearchDocument`) and the bulk backfill (`src/api/src/enrichment/meilisearch-backfill-compose.ts` → `composeDocument`). Every field added in this plan is added to a **shared** helper both call. A field added to one only is a silent ranking bug for half the corpus.
- **Every key the embedder template dereferences must appear in `TEMPLATE_FIELD_DEFAULTS`** (`meilisearch-client.ts:264`). Meilisearch renders the template with strict Liquid lookups; a document missing a referenced key rejects **its entire batch** with `invalid_document_fields`. This was hit live in #2369 by tombstone documents (`{ id, deletedAt }`) during the semantic backfill.
- **Formatting:** `cd src/web && bun run format` is the only style gate the repo has for TS. Never hand-roll Prettier output. The API is checked by the same pinned binary — run `./src/web/node_modules/.bin/prettier --write <files>` for files under `src/api`.
- **Tests:** `cd src/api && bun test`. Integration tests that need a live Meilisearch/Ollama are env-gated and **skip-pass** when the env is unset, mirroring `test_color_pipeline.sh`.
- **Ticket:** every commit message and the PR body reference #2384. PR body must contain `Closes #2384`.

---

## Review of the issue — what is right, what is missing

Read this before Task 1; it changes what you emphasise.

**The issue's diagnosis is correct but understates the cause.** It says descriptions are embedded twice and transcripts are "buried inside a combined blob." The stronger fact, verifiable at `src/api/src/enrichment/search-blob.ts:53-85`, is that `composeSearchBlob` lowercases, splits on whitespace, **dedupes via a `Set`, and sorts alphabetically**. So the blob for IMG_4185.MOV is literally of the form:

```text
3 basement condensate controller harmony heat installed lennox pumps replaced run sensors shortened zone
```

Sentence structure, word order, and repetition — everything a sentence embedder like `bge-m3` uses — are destroyed before the text reaches the embedder, and this destroyed text is the **first and longest** segment of the template. A generic photo caption ("Rooftop HVAC units on a commercial building") arrives at the embedder as fluent prose in `{{ doc.description }}`. That asymmetry, not merely the duplication, is why prose captions beat a real transcript. Removing `searchBlob` from the template and adding a prose `transcript` field is therefore the load-bearing change, and it should be landed and measured before anything else in the issue is attempted.

**Three hazards the issue does not mention. All three are addressed below.**

1. **The template string is written twice.** `meilisearch-index-settings.ts:41` sets it; `meilisearch-client.ts:244` hashes a hand-copied duplicate of it into `vectorFingerprint`. Change one and not the other and the fingerprint does not move — vector coverage is never invalidated, no re-embed is triggered, and acceptance criterion 3 silently fails while appearing to pass. Task 1 single-sources it.
2. **Coverage is carried forward across the change, falsely.** `initializeHttpSearch` (`meilisearch-http-bootstrap.ts:32-33`) calls `ensureIndex()` and then `advanceKnownVectorCoverage(newFingerprint)`, which stamps every already-vectorized row with the new fingerprint. That is correct for a pure template/model change — Meilisearch re-embeds existing documents itself when embedder settings change. It is **wrong here**, because our new template references fields (`transcript`, `placeText`) that the currently-indexed documents do not have. Meilisearch would re-embed against missing fields, mark 100% coverage, and the operator would see nothing to backfill. Task 4 fixes this with a document-shape version baked into the fingerprint.
3. **`placeText` has no good source yet.** `place.search_blob` is _also_ an alphabetised token bag (`place-parser.ts:160`). The prose field is `place.display_name`. Use that.

**Scope call on issue item 6 (second-stage reranker).** The issue frames it conditionally — "if field-aware indexing and blend tuning are insufficient." Per CLAUDE.md principle 7 (YAGNI), it is not built up front. Task 7 is an explicit decision gate: if the measured Recall@10 / MRR after Tasks 1–6 clears the budget and the HVAC fixture lands in the top 5, the reranker is not built and the follow-up ticket is closed as not-needed; if it does not, the ticket carries the measurement into a scoped follow-up. This is deliberate staged work with a referenced ticket, which principle 6 permits — it is not a silent omission.

---

## File Structure

**New files**

| File                                                      | Responsibility                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/src/enrichment/meilisearch-embedder-template.ts` | Single source of the embedder `documentTemplate`, the `ASSET_DOC_SHAPE_VERSION` constant, and the `vectorFingerprint` hash. Imported by both `meilisearch-index-settings.ts` and `meilisearch-client.ts`. Also relieves `meilisearch-client.ts`'s 32-line budget headroom. |
| `src/api/src/enrichment/asset-doc-fields.ts`              | Pure derivation of the new document fields (`transcriptForIndex`, `placeTextForIndex`) shared by the stage writer and the backfill writer, so the two cannot drift.                                                                                                        |
| `src/api/src/enrichment/search-relevance-metrics.ts`      | Pure `recallAtK` / `meanReciprocalRank` / `reportLine`. No network. Unit-tested in CI.                                                                                                                                                                                     |
| `src/api/tests/fixtures/search-relevance/corpus.json`     | Committed relevance corpus — Meilisearch-document-shaped rows including IMG_4185.MOV and its real competitors.                                                                                                                                                             |
| `src/api/tests/fixtures/search-relevance/queries.json`    | Query → relevant-id labels.                                                                                                                                                                                                                                                |
| `src/api/tests/fixtures/search-relevance/budgets.json`    | Recall@10 / MRR / top-5 ceilings. One-way ratchet, like `test-fixtures/budgets.json`.                                                                                                                                                                                      |
| `src/api/tests/search-relevance.integration.test.ts`      | Env-gated end-to-end relevance gate against real Meilisearch + Ollama.                                                                                                                                                                                                     |
| `src/scripts/test_search_relevance.sh`                    | Operator-facing wrapper; skip-passes without env, mirrors `test_color_pipeline.sh`.                                                                                                                                                                                        |
| `src/api/tools/export-search-corpus.ts`                   | Operator script: export a real sample of Meilisearch documents from a live deployment to extend the corpus without hand-authoring.                                                                                                                                         |

**Modified files**

| File                                                             | Change                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/src/enrichment/meilisearch-client.ts:78-129, 235-268`   | `MeilisearchAssetDoc` gains `transcript` / `placeText`; `TEMPLATE_FIELD_DEFAULTS` gains every new template key; `vectorFingerprint` moves out. |
| `src/api/src/enrichment/meilisearch-index-settings.ts:20-50`     | New `searchableAttributes` order; template imported, not inlined.                                                                              |
| `src/api/src/workers/stages/meili.ts:126-177, 257-296`           | `meilisearchDocument` writes the new fields; `targetVersion` → `ASSET_DOC_SHAPE_VERSION`.                                                      |
| `src/api/src/enrichment/meilisearch-backfill-compose.ts:118-146` | `composeDocument` writes the new fields.                                                                                                       |
| `src/api/src/enrichment/meilisearch-vector-coverage.ts:27-39`    | Carry-forward gated on matching document-shape version.                                                                                        |
| `src/api/src/routes/service-asset-search.ts`                     | No behaviour change — Task 5 only adds tests around it.                                                                                        |
| `docs/indexer-enrichment.md`                                     | Document the new fields, the template, and the re-embed procedure.                                                                             |

---

## Task 1: Single-source the embedder template and fingerprint

Nothing else can land safely until the template exists in exactly one place. This task is a pure refactor — behaviour identical, fingerprint byte-identical — so it is independently reviewable and independently revertible.

**Files:**

- Create: `src/api/src/enrichment/meilisearch-embedder-template.ts`
- Create: `src/api/src/enrichment/meilisearch-embedder-template.test.ts`
- Modify: `src/api/src/enrichment/meilisearch-client.ts` (remove `vectorFingerprint`, lines 235-248; remove the now-unused `createHash` import at line 25)
- Modify: `src/api/src/enrichment/meilisearch-index-settings.ts` (import the template instead of inlining it at line 41)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `ASSET_DOC_SHAPE_VERSION: number` — currently `7`, bumped to `8` in Task 2.
  - `EMBEDDER_DOCUMENT_TEMPLATE: string`
  - `vectorFingerprint(config: { embedderName: string; embedUrl: string; model: string }): string`

- [ ] **Step 1: Write the failing test**

Create `src/api/src/enrichment/meilisearch-embedder-template.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  ASSET_DOC_SHAPE_VERSION,
  EMBEDDER_DOCUMENT_TEMPLATE,
  vectorFingerprint,
} from './meilisearch-embedder-template.ts';
import { assetsIndexSettings } from './meilisearch-index-settings.ts';

const config = {
  embedderName: 'caption',
  embedUrl: 'http://localhost:11434/api/embed',
  model: 'bge-m3',
};

describe('meilisearch embedder template', () => {
  it('is the single source the index settings use', () => {
    const settings = assetsIndexSettings(
      {
        semantic: true,
        embedderUrl: 'http://localhost:11434',
        embedderModel: 'bge-m3',
      },
      'caption',
    );
    const embedders = settings.embedders as Record<string, { documentTemplate: string }>;
    expect(embedders.caption.documentTemplate).toBe(EMBEDDER_DOCUMENT_TEMPLATE);
  });

  it('produces a stable, shape-versioned fingerprint', () => {
    const fingerprint = vectorFingerprint(config);
    expect(fingerprint).toBe(vectorFingerprint(config));
    expect(fingerprint.startsWith(`v${ASSET_DOC_SHAPE_VERSION}:`)).toBe(true);
  });

  it('changes when the model changes', () => {
    expect(vectorFingerprint(config)).not.toBe(vectorFingerprint({ ...config, model: 'other' }));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd src/api && bun test src/enrichment/meilisearch-embedder-template.test.ts
```

Expected: FAIL — `Cannot find module './meilisearch-embedder-template.ts'`.

- [ ] **Step 3: Create the module**

Create `src/api/src/enrichment/meilisearch-embedder-template.ts`:

```ts
/**
 * Single source of truth for the managed embedder's document template and
 * the fingerprint that identifies the active vector configuration.
 *
 * Why its own module: the template string was previously written twice —
 * once in `meilisearch-index-settings.ts` (what Meilisearch is told) and
 * once in `meilisearch-client.ts`'s fingerprint hash (what decides whether
 * a re-embed is needed). Editing one and not the other left every asset
 * marked as vector-covered under a template it was never embedded with.
 *
 * `ASSET_DOC_SHAPE_VERSION` is the version of the DOCUMENT we push, not of
 * the template alone. It is folded into the fingerprint so a change to the
 * set of fields the template dereferences invalidates coverage — Meilisearch
 * re-embeds from documents already in the index, so a template that reads a
 * field the indexed documents do not carry yet must NOT be treated as
 * covered. See `meilisearch-vector-coverage.ts`.
 *
 * The meili stage's `targetVersion` is bound to this constant: a document
 * shape change is exactly the condition under which every asset must be
 * re-upserted.
 */

import { createHash } from 'node:crypto';

/** Bump whenever the fields written into `MeilisearchAssetDoc` change. */
export const ASSET_DOC_SHAPE_VERSION = 7;

/** Rendered by Meilisearch for every document to produce the embedding input. */
export const EMBEDDER_DOCUMENT_TEMPLATE =
  '{{ doc.searchBlob }} {{ doc.description }} {{ doc.people }}';

export interface VectorFingerprintInput {
  /** The Meili embedder name we register (`caption`). */
  embedderName: string;
  /** Fully-joined Ollama embed endpoint. */
  embedUrl: string;
  /** Ollama embedding model id. */
  model: string;
}

/**
 * Stable, non-secret identity of the active vector configuration, prefixed
 * with the document-shape version so callers can compare shapes without
 * re-deriving the hash.
 */
export function vectorFingerprint(input: VectorFingerprintInput): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        embedder: input.embedderName,
        url: input.embedUrl,
        model: input.model,
        documentTemplate: EMBEDDER_DOCUMENT_TEMPLATE,
      }),
    )
    .digest('hex');
  return `v${ASSET_DOC_SHAPE_VERSION}:${digest}`;
}
```

- [ ] **Step 4: Point the index settings at it**

In `src/api/src/enrichment/meilisearch-index-settings.ts`, add to the imports:

```ts
import { EMBEDDER_DOCUMENT_TEMPLATE } from './meilisearch-embedder-template.ts';
```

and replace line 41:

```ts
        documentTemplate: EMBEDDER_DOCUMENT_TEMPLATE,
```

- [ ] **Step 5: Point the client at it**

In `src/api/src/enrichment/meilisearch-client.ts`:

- Delete the `import { createHash } from 'node:crypto';` line (line 25).
- Delete the whole local `vectorFingerprint` function (lines 235-248).
- Add to the imports:

```ts
import {
  vectorFingerprint as computeVectorFingerprint,
  type VectorFingerprintInput,
} from './meilisearch-embedder-template.ts';
```

- Add this local adapter just above `interface MeiliSearchResponse`:

```ts
function fingerprintFor(config: ClientConfig): string | null {
  if (!isLiveConfig(config) || !config.semantic) return null;
  const input: VectorFingerprintInput = {
    embedderName: EMBEDDER_NAME,
    embedUrl: joinMeilisearchUrl(config.embedderUrl, '/api/embed'),
    model: config.embedderModel,
  };
  return computeVectorFingerprint(input);
}
```

- Change the `semanticFingerprint` method body (around line 411) to:

```ts
    semanticFingerprint(): string | null {
      return fingerprintFor(cfg);
    },
```

- [ ] **Step 6: Run the tests**

```bash
cd src/api && bun test src/enrichment/ tests/admin-backfill-meilisearch.test.ts
```

Expected: PASS. If a test asserts a hard-coded fingerprint hex string, it will fail on the new `v7:` prefix — update that expectation to the prefixed form; that is the intended new contract.

- [ ] **Step 7: Confirm the budget headroom actually moved**

```bash
tools/check-file-budget.sh src/api/src
```

Expected: no `ERROR` lines. `meilisearch-client.ts` should now be roughly 555 lines or fewer.

- [ ] **Step 8: Format and commit**

```bash
./src/web/node_modules/.bin/prettier --write "src/api/src/enrichment/meilisearch-*.ts"
```

```bash
git add src/api/src/enrichment/meilisearch-embedder-template.ts src/api/src/enrichment/meilisearch-embedder-template.test.ts src/api/src/enrichment/meilisearch-client.ts src/api/src/enrichment/meilisearch-index-settings.ts && git commit -m "refactor(api): single-source the Meilisearch embedder template and fingerprint (#2384)"
```

---

## Task 2: Add `transcript` and `placeText` to the asset document

**Files:**

- Create: `src/api/src/enrichment/asset-doc-fields.ts`
- Create: `src/api/src/enrichment/asset-doc-fields.test.ts`
- Modify: `src/api/src/enrichment/meilisearch-client.ts` (`MeilisearchAssetDoc`, `TEMPLATE_FIELD_DEFAULTS`)
- Modify: `src/api/src/workers/stages/meili.ts` (`meilisearchDocument`, `targetVersion`)
- Modify: `src/api/src/enrichment/meilisearch-backfill-compose.ts` (`composeDocument`)
- Modify: `src/api/src/enrichment/meilisearch-embedder-template.ts` (bump `ASSET_DOC_SHAPE_VERSION` to 8)
- Test: `src/api/src/workers/stages/meili.test.ts`, `src/api/tests/meilisearch-backfill-resilience.test.ts`

**Interfaces:**

- Consumes: `ASSET_DOC_SHAPE_VERSION` from Task 1.
- Produces:
  - `transcriptForIndex(transcript: IndexableTranscript | null | undefined): string | null`
  - `placeTextForIndex(place: IndexablePlace | null | undefined): string | null`

  The two writers hold different types for the same data — the stage's `SearchableImage.transcript` is `{ text?: string }` (`meili.ts:129`) while the backfill's `BackfillRow.transcript` is `TranscriptDoc | null` (`meilisearch-backfill-compose.ts:44`, where `text: string` is required). The helpers therefore take **structural** parameter types that both satisfy, not `Pick<TranscriptDoc, 'text'>`, which the stage's optional `text` would not assign to.
  - `MAX_INDEXED_TRANSCRIPT_CHARS: number`
  - `MeilisearchAssetDoc.transcript?: string | null`, `MeilisearchAssetDoc.placeText?: string | null`

- [ ] **Step 1: Write the failing test for the shared field helpers**

Create `src/api/src/enrichment/asset-doc-fields.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  MAX_INDEXED_TRANSCRIPT_CHARS,
  placeTextForIndex,
  transcriptForIndex,
} from './asset-doc-fields.ts';

describe('transcriptForIndex', () => {
  it('returns null for a missing transcript', () => {
    expect(transcriptForIndex(null)).toBeNull();
    expect(transcriptForIndex(undefined)).toBeNull();
    expect(transcriptForIndex({ text: '   ' })).toBeNull();
  });

  it('preserves prose word order and repetition', () => {
    const text = 'We just have the heat pumps installed on the Harmony 3 zone controller.';
    expect(transcriptForIndex({ text })).toBe(text);
  });

  it('caps very long transcripts at a whitespace boundary', () => {
    const long = 'word '.repeat(MAX_INDEXED_TRANSCRIPT_CHARS);
    const capped = transcriptForIndex({ text: long })!;
    expect(capped.length).toBeLessThanOrEqual(MAX_INDEXED_TRANSCRIPT_CHARS);
    expect(capped.endsWith(' ')).toBe(false);
    expect(capped.startsWith('word word')).toBe(true);
  });
});

describe('placeTextForIndex', () => {
  it('prefers the prose display name over nothing', () => {
    expect(placeTextForIndex({ display_name: '12 Elm St, Albany, NY, USA' })).toBe(
      '12 Elm St, Albany, NY, USA',
    );
  });

  it('returns null when there is no place or no display name', () => {
    expect(placeTextForIndex(null)).toBeNull();
    expect(placeTextForIndex({ display_name: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd src/api && bun test src/enrichment/asset-doc-fields.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the shared helpers**

Create `src/api/src/enrichment/asset-doc-fields.ts`:

```ts
/**
 * Pure derivation of the prose-valued Meilisearch document fields, shared by
 * the two writers that build `MeilisearchAssetDoc`: the per-asset meili stage
 * (`workers/stages/meili.ts`) and the bulk backfill
 * (`meilisearch-backfill-compose.ts`). A field added to one writer only is a
 * silent ranking bug for half the corpus, so both call these.
 *
 * "Prose" is the point. `search_blob` is a lowercased, deduped,
 * alphabetically-sorted token bag (see `search-blob.ts`) — fine for the Mongo
 * `$text` fallback, useless as embedder input, because word order and
 * repetition are exactly what a sentence embedder reads. These fields carry
 * the original text through to the index unmodified.
 */

/** Structural shape both writers satisfy. The meili stage models the field as
 * `{ text?: string }` and the backfill as `TranscriptDoc` (`text: string`);
 * an optional-property type accepts both. */
export interface IndexableTranscript {
  text?: string | null;
}

/** Same story for place — `Place.display_name` is `string | null`. */
export interface IndexablePlace {
  display_name?: string | null;
}

/**
 * Character ceiling for the indexed transcript.
 *
 * `bge-m3` accepts 8192 tokens (~30k characters of English). The embedder
 * template also carries description, OCR text, people, and place, so budgeting
 * ~12k characters to the transcript keeps the whole rendered document inside
 * the context window with room to spare. Beyond that Ollama truncates
 * silently, and because `transcript` is the LAST field in the template
 * (see `meilisearch-embedder-template.ts`) the truncation would eat the
 * transcript tail rather than the shorter, denser fields — but an explicit,
 * tested cap is cheaper to reason about than relying on that ordering. The
 * full transcript remains searchable lexically via `search_blob` and remains
 * intact in Mongo; only the indexed copy is bounded.
 */
export const MAX_INDEXED_TRANSCRIPT_CHARS = 12_000;

/** The asset's spoken content as prose, capped and trimmed. `null` when the
 * transcribe stage has not run or produced nothing. */
export function transcriptForIndex(
  transcript: IndexableTranscript | null | undefined,
): string | null {
  const text = transcript?.text?.trim() ?? '';
  if (text.length === 0) return null;
  if (text.length <= MAX_INDEXED_TRANSCRIPT_CHARS) return text;
  const window = text.slice(0, MAX_INDEXED_TRANSCRIPT_CHARS);
  const lastSpace = window.lastIndexOf(' ');
  return (lastSpace > 0 ? window.slice(0, lastSpace) : window).trimEnd();
}

/** The asset's location as prose. Uses `place.display_name` — NOT
 * `place.search_blob`, which is itself an alphabetised token bag built by
 * `place-parser.ts:buildSearchBlob` and carries the same
 * destroys-the-semantics problem as the asset-level blob. */
export function placeTextForIndex(place: IndexablePlace | null | undefined): string | null {
  const text = place?.display_name?.trim() ?? '';
  return text.length === 0 ? null : text;
}
```

- [ ] **Step 4: Run the helper test**

```bash
cd src/api && bun test src/enrichment/asset-doc-fields.test.ts
```

Expected: PASS.

- [ ] **Step 5: Widen the document type and the template defaults**

In `src/api/src/enrichment/meilisearch-client.ts`, inside `interface MeilisearchAssetDoc`, add after the `ocrText` field (around line 96):

```ts
  /** Speech-to-text transcript as PROSE — word order and repetition intact,
   * capped at `MAX_INDEXED_TRANSCRIPT_CHARS`. This is the field that makes a
   * transcript-rich video rank on what was actually said rather than on the
   * alphabetised `searchBlob` bag. `null` before the transcribe stage runs. */
  transcript?: string | null;
  /** Reverse-geocoded `place.display_name` as prose. `null` before geocode. */
  placeText?: string | null;
```

Then replace `TEMPLATE_FIELD_DEFAULTS` (line 264) with:

```ts
const TEMPLATE_FIELD_DEFAULTS = {
  searchBlob: '',
  filename: '',
  mediaType: null,
  description: null,
  transcript: null,
  ocrText: null,
  people: null,
  placeText: null,
};
```

Update the comment above it so the invariant is stated where the next person will read it — every key the template dereferences must appear here or a tombstone document (`{ id, deletedAt }`) rejects its whole batch (#2369).

- [ ] **Step 6: Write the failing writer-parity test**

Append to `src/api/src/workers/stages/meili.test.ts`:

```ts
import { composeDocument } from '../../enrichment/meilisearch-backfill-compose.ts';

describe('document field parity between the two writers', () => {
  it('both writers emit transcript and placeText', async () => {
    const captured: MeilisearchAssetDoc[] = [];
    setMeilisearchClientForTests({
      isConfigured: () => true,
      semanticConfigured: () => true,
      semanticFingerprint: () => 'v8:test',
      health: async () => true,
      ensureIndex: async () => {},
      upsert: async () => {},
      upsertOrThrow: async (doc) => {
        captured.push(doc);
      },
      tombstone: async () => {},
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    } as never);

    const row = {
      maple_id: 'abc',
      fileinfo: [{ library_id: new ObjectId(), filename: 'IMG_4185.MOV' }],
      description: 'A basement mechanical room.',
      transcript: { text: 'just have the heat pumps installed' },
      place: { display_name: '12 Elm St, Albany, NY, USA' },
    };

    await meiliHandler(row as never, {} as never);
    setMeilisearchClientForTests(null);

    const staged = captured[0]!;
    expect(staged.transcript).toBe('just have the heat pumps installed');
    expect(staged.placeText).toBe('12 Elm St, Albany, NY, USA');

    const backfilled = composeDocument(
      row as never,
      'abc',
      row.fileinfo[0]!.library_id,
      'IMG_4185.MOV',
      [],
    );
    expect(backfilled.transcript).toBe(staged.transcript);
    expect(backfilled.placeText).toBe(staged.placeText);
  });
});
```

Add whatever imports the file is missing (`ObjectId` from `mongodb`, `MeilisearchAssetDoc` type) at the top, matching the file's existing import style.

- [ ] **Step 7: Run it to confirm it fails**

```bash
cd src/api && bun test src/workers/stages/meili.test.ts
```

Expected: FAIL — `expect(undefined).toBe('just have the heat pumps installed')`.

- [ ] **Step 8: Write the fields in the stage writer**

In `src/api/src/workers/stages/meili.ts`, import the helpers:

```ts
import { placeTextForIndex, transcriptForIndex } from '../../enrichment/asset-doc-fields.ts';
```

and inside `meilisearchDocument`, add after the `ocrText` line:

```ts
    transcript: transcriptForIndex(image.transcript),
    placeText: placeTextForIndex(image.place),
```

- [ ] **Step 9: Write the fields in the backfill writer**

In `src/api/src/enrichment/meilisearch-backfill-compose.ts`, import:

```ts
import { placeTextForIndex, transcriptForIndex } from './asset-doc-fields.ts';
```

and inside `composeDocument`'s returned object, add after the `ocrText` line:

```ts
    transcript: transcriptForIndex(row.transcript),
    placeText: placeTextForIndex(row.place),
```

`ROW_PROJECTION` already fetches `transcript` and `place`, so no projection change is needed — confirm this by reading `meilisearch-backfill-compose.ts:57-73` rather than assuming.

- [ ] **Step 10: Bump the document-shape version and bind the stage to it**

In `src/api/src/enrichment/meilisearch-embedder-template.ts`:

```ts
export const ASSET_DOC_SHAPE_VERSION = 8;
```

In `src/api/src/workers/stages/meili.ts`, import it and replace the literal `targetVersion: 7`:

```ts
import { ASSET_DOC_SHAPE_VERSION } from '../../enrichment/meilisearch-embedder-template.ts';
```

```ts
  // v8: the document carries prose `transcript` and `placeText` fields so the
  // embedder reads real sentences instead of the alphabetised `searchBlob`
  // bag (#2384). Bound to ASSET_DOC_SHAPE_VERSION because a document-shape
  // change is exactly the condition under which every asset must re-upsert.
  targetVersion: ASSET_DOC_SHAPE_VERSION,
```

Keep the existing v2–v7 history comment block above it — it is the change log for this stage.

- [ ] **Step 11: Run the suite**

```bash
cd src/api && bun test
```

Expected: PASS. Tests that assert an exact `MeilisearchAssetDoc` shape with `toEqual` will fail on the two new keys — add `transcript: null, placeText: null` to those expectations.

- [ ] **Step 12: Format, budget-check, commit**

```bash
./src/web/node_modules/.bin/prettier --write "src/api/src/enrichment/*.ts" "src/api/src/workers/stages/meili.ts"
```

```bash
tools/check-file-budget.sh src/api/src
```

```bash
git add src/api/src/enrichment/asset-doc-fields.ts src/api/src/enrichment/asset-doc-fields.test.ts src/api/src/enrichment/meilisearch-client.ts src/api/src/enrichment/meilisearch-backfill-compose.ts src/api/src/enrichment/meilisearch-embedder-template.ts src/api/src/workers/stages/meili.ts src/api/src/workers/stages/meili.test.ts && git commit -m "feat(api): index transcript and placeText as first-class asset fields (#2384)"
```

---

## Task 3: Labelled embedding template and evidence-aware lexical order

**Files:**

- Modify: `src/api/src/enrichment/meilisearch-embedder-template.ts` (`EMBEDDER_DOCUMENT_TEMPLATE`)
- Modify: `src/api/src/enrichment/meilisearch-index-settings.ts` (`searchableAttributes`)
- Test: `src/api/src/enrichment/meilisearch-embedder-template.test.ts`, `src/api/src/enrichment/meilisearch-client.test.ts`

**Interfaces:**

- Consumes: the document fields from Task 2.
- Produces: the final template string and attribute order that Task 6 measures.

- [ ] **Step 1: Write the failing template test**

Append to `src/api/src/enrichment/meilisearch-embedder-template.test.ts`:

```ts
describe('template content', () => {
  it('does not duplicate description text via searchBlob', () => {
    expect(EMBEDDER_DOCUMENT_TEMPLATE).not.toContain('doc.searchBlob');
    expect(EMBEDDER_DOCUMENT_TEMPLATE).toContain('doc.description');
  });

  it('labels every source so the embedder sees field semantics', () => {
    for (const label of [
      'Filename:',
      'Media type:',
      'Visual description:',
      'People:',
      'Place:',
      'OCR:',
      'Video transcript:',
    ]) {
      expect(EMBEDDER_DOCUMENT_TEMPLATE).toContain(label);
    }
  });

  it('puts the transcript last so context truncation eats its tail, not the dense fields', () => {
    const transcriptAt = EMBEDDER_DOCUMENT_TEMPLATE.indexOf('doc.transcript');
    for (const field of ['doc.filename', 'doc.description', 'doc.people', 'doc.placeText']) {
      expect(EMBEDDER_DOCUMENT_TEMPLATE.indexOf(field)).toBeLessThan(transcriptAt);
    }
  });

  it('references only keys that TEMPLATE_FIELD_DEFAULTS covers', async () => {
    const { templateFieldDefaultsForTests } = await import('./meilisearch-client.ts');
    const referenced = [...EMBEDDER_DOCUMENT_TEMPLATE.matchAll(/doc\.(\w+)/g)].map((m) => m[1]!);
    for (const key of referenced) {
      expect(Object.keys(templateFieldDefaultsForTests)).toContain(key);
    }
  });
});
```

- [ ] **Step 2: Write the failing searchable-attribute test**

Append to `src/api/src/enrichment/meilisearch-client.test.ts` (or create `meilisearch-index-settings.test.ts` if the client test file is near the 400-line soft limit — check with `wc -l` first):

```ts
describe('searchable attribute order', () => {
  it('ranks named people and transcript above generic captions, filename first', () => {
    const settings = assetsIndexSettings(
      {
        semantic: true,
        embedderUrl: 'http://localhost:11434',
        embedderModel: 'bge-m3',
      },
      'caption',
    );
    expect(settings.searchableAttributes).toEqual([
      'filename',
      'people',
      'transcript',
      'ocrText',
      'description',
      'placeText',
      'searchBlob',
    ]);
  });
});
```

The order encodes three claims about intent, and Meilisearch's `attribute` ranking rule is what enforces them — a match in an earlier attribute outranks the same match in a later one.

- **`filename` first.** Exact-identifier queries (`IMG_4185.MOV`) must stay top-1; that is acceptance criterion 7.
- **`people` second.** Searching a person's name is an unambiguous, high-intent query: the user wants photos _of_ that person, not a video whose transcript mentions the name in passing or a screenshot whose OCR happens to contain it. `people` holds only resolved `PersonDoc.name`s — auto-generated `Person N` clusters and merged rows are already excluded upstream (`meili.ts:38, 54-80`) — so it is a small, high-precision field, exactly the kind that deserves top weight. It also composes with the existing explicit filter path (`people IN [...]`, `meilisearch-filter.ts:18`) rather than competing with it.
- **`transcript` then `ocrText` then `description`.** What was actually said or written outranks what a captioner guessed. This is the #2384 change.

`searchBlob` stays last — it is the only home for the structured vision tokens and place tokens, so it must remain searchable, but at the lowest weight.

The one real tradeoff in raising `people`: a person whose name is also a common noun ("Rose", "Mark", "Summer") will pull their photos above literal matches for the same word. That is **out of scope for this pass** and owned by **#2386**. Task 6 Step 6 still commits the fixture pair and records where each document lands, so #2386 starts from measured data instead of a guess — but it asserts nothing about the outcome here.

- [ ] **Step 3: Run both to confirm they fail**

```bash
cd src/api && bun test src/enrichment/meilisearch-embedder-template.test.ts src/enrichment/meilisearch-client.test.ts
```

Expected: FAIL on the template content and on the attribute order.

- [ ] **Step 4: Replace the template**

In `src/api/src/enrichment/meilisearch-embedder-template.ts`:

```ts
/**
 * Rendered by Meilisearch for every document to produce the embedding input.
 *
 * Labelled, one field per line, and deliberately NOT including `searchBlob`.
 * The previous template (`{{ doc.searchBlob }} {{ doc.description }}
 * {{ doc.people }}`) had two defects: it embedded description twice, and its
 * largest segment was `searchBlob` — a lowercased, deduped, ALPHABETICALLY
 * SORTED token bag. A sentence embedder reads word order and repetition; the
 * blob has neither, so a real video transcript arrived at the embedder as
 * scrambled tokens while a generic photo caption arrived as fluent prose.
 * That asymmetry is why transcript-rich videos under-ranked (#2384).
 *
 * `transcript` is last: it is by far the longest field, so if Ollama's context
 * window is reached the truncation lands in the transcript tail rather than
 * dropping the shorter, denser fields entirely. `asset-doc-fields.ts` also
 * caps it explicitly.
 */
export const EMBEDDER_DOCUMENT_TEMPLATE = [
  'Filename: {{ doc.filename }}',
  'Media type: {{ doc.mediaType }}',
  // People sits high here for the same reason it sits second in
  // `searchableAttributes`: a name query wants photos OF that person. The
  // field is short, so its position costs nothing downstream.
  'People: {{ doc.people }}',
  'Visual description: {{ doc.description }}',
  'Place: {{ doc.placeText }}',
  'OCR: {{ doc.ocrText }}',
  'Video transcript: {{ doc.transcript }}',
].join('\n');
```

- [ ] **Step 5: Export the defaults for the coverage assertion**

In `src/api/src/enrichment/meilisearch-client.ts`, immediately after the `TEMPLATE_FIELD_DEFAULTS` declaration:

```ts
/** Test-only view of the defaults so the template test can assert that every
 * key the template dereferences is covered here — the #2369 invariant. */
export const templateFieldDefaultsForTests = TEMPLATE_FIELD_DEFAULTS;
```

- [ ] **Step 6: Reorder the searchable attributes**

In `src/api/src/enrichment/meilisearch-index-settings.ts`, replace line 21:

```ts
    searchableAttributes: [
      'filename',
      'people',
      'transcript',
      'ocrText',
      'description',
      'placeText',
      'searchBlob',
    ],
```

`assetsIndexSettingsMatch` already compares `searchableAttributes` as an **ordered** array (`sameStringArray`, line 56), so this change correctly triggers a settings PATCH on next boot. Do not change that comparison.

- [ ] **Step 7: Run the tests**

```bash
cd src/api && bun test src/enrichment/
```

Expected: PASS.

- [ ] **Step 8: Format and commit**

```bash
./src/web/node_modules/.bin/prettier --write "src/api/src/enrichment/*.ts"
```

```bash
git add src/api/src/enrichment/meilisearch-embedder-template.ts src/api/src/enrichment/meilisearch-embedder-template.test.ts src/api/src/enrichment/meilisearch-index-settings.ts src/api/src/enrichment/meilisearch-client.ts src/api/src/enrichment/meilisearch-client.test.ts && git commit -m "feat(api): labelled non-duplicating embedding template, evidence-first attribute order (#2384)"
```

---

## Task 4: Correct vector-coverage invalidation across a shape change

Without this task the change ships and the operator sees 100% vector coverage with vectors built from documents that never had a transcript. This is the acceptance criterion the issue lists as item 3 and the one most likely to be silently wrong.

**Files:**

- Modify: `src/api/src/enrichment/meilisearch-vector-coverage.ts`
- Create: `src/api/src/enrichment/meilisearch-vector-coverage.test.ts`

**Interfaces:**

- Consumes: `ASSET_DOC_SHAPE_VERSION` and the `v<N>:<hash>` fingerprint format from Task 1.
- Produces:
  - `documentShapeOf(fingerprint: string | null | undefined): string | null`
  - `advanceKnownVectorCoverage` that carries coverage forward only within the same document shape.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/enrichment/meilisearch-vector-coverage.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { documentShapeOf } from './meilisearch-vector-coverage.ts';

describe('documentShapeOf', () => {
  it('extracts the shape prefix so same-shape fingerprints carry forward', () => {
    // Two fingerprints differing only in model/url share a shape: Meilisearch
    // re-embeds the documents already in its index, so coverage is real.
    expect(documentShapeOf('v8:aaa')).toBe('v8');
    expect(documentShapeOf('v8:bbb')).toBe('v8');
  });

  it('distinguishes a document-shape change', () => {
    // A new shape means the template reads fields the indexed documents do
    // not carry, so the re-embed is against missing data and must not count.
    expect(documentShapeOf('v7:aaa')).not.toBe(documentShapeOf('v8:aaa'));
  });

  it('returns null for an unprefixed legacy fingerprint', () => {
    expect(documentShapeOf('aaa')).toBeNull();
  });

  it('returns null for a missing fingerprint', () => {
    expect(documentShapeOf(null)).toBeNull();
    expect(documentShapeOf(undefined)).toBeNull();
    expect(documentShapeOf(':aaa')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd src/api && bun test src/enrichment/meilisearch-vector-coverage.test.ts
```

Expected: FAIL — `documentShapeOf is not a function`.

- [ ] **Step 3: Implement the shape gate**

In `src/api/src/enrichment/meilisearch-vector-coverage.ts`, add:

```ts
/**
 * The `v<N>` document-shape prefix of a fingerprint, or `null` for an
 * unprefixed legacy value.
 *
 * Coverage carries forward only within one shape. A settings PATCH makes
 * Meilisearch re-embed the documents ALREADY IN ITS INDEX — which is why a
 * pure model/url/template-wording change carries forward safely. But when the
 * document shape changes, the template dereferences fields those indexed
 * documents do not carry yet, so the re-embed happens against missing data.
 * Counting that as coverage would show the operator 100% while every vector
 * was built without a transcript (#2384).
 */
export function documentShapeOf(fingerprint: string | null | undefined): string | null {
  if (!fingerprint) return null;
  const colon = fingerprint.indexOf(':');
  if (colon <= 0 || fingerprint[0] !== 'v') return null;
  return fingerprint.slice(0, colon);
}
```

and change `advanceKnownVectorCoverage` to filter on the shape prefix:

```ts
export async function advanceKnownVectorCoverage(
  fingerprint: string | null | undefined,
): Promise<void> {
  if (!fingerprint) return;
  const shape = documentShapeOf(fingerprint);
  if (shape === null) return;
  await (
    await assetsCollection()
  ).updateMany(
    {
      ...LIVE_ASSET_FILTER,
      // Only rows whose stored fingerprint has the SAME document shape.
      // A shape change leaves every row uncovered, which is what surfaces
      // "re-embed needed" on Settings → Workers and what the backfill route
      // then works through. See `documentShapeOf`.
      semantic_vector_fingerprint: { $regex: `^${shape}:` },
    } as never,
    { $set: { semantic_vector_fingerprint: fingerprint } },
  );
}
```

Update the doc comment above the function to state the new invariant.

- [ ] **Step 4: Run it to confirm it passes**

```bash
cd src/api && bun test src/enrichment/meilisearch-vector-coverage.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the integration tests that exercise coverage**

```bash
cd src/api && bun test tests/admin-backfill-meilisearch.test.ts tests/admin-backfill-meilisearch-migration.test.ts tests/enrichment-route-meilisearch.test.ts src/workers/enrichment-config-refresh.test.ts
```

Expected: PASS. These need a live Mongo — see the repo note on standing up a throwaway `mongod` on port 27077 if they error on connection.

- [ ] **Step 6: Document the operator re-embed procedure**

In `docs/indexer-enrichment.md`, in the Meilisearch section, add:

```markdown
### Re-embedding after a document-shape change

The semantic fingerprint is `v<ASSET_DOC_SHAPE_VERSION>:<sha256>`. When the
shape version changes (a new field in `MeilisearchAssetDoc`), coverage is NOT
carried forward: every asset reads as un-vectorized until it is re-upserted
with the new fields. Two paths converge on that, and both are safe to run:

1. **Automatic** — the meili stage's `targetVersion` is bound to
   `ASSET_DOC_SHAPE_VERSION`, so every asset becomes eligible again and the
   stage re-upserts it. Slow (concurrency 2) but needs no operator action.
2. **Operator-driven** — `POST /api/admin/enrichment/backfill-meilisearch`
   (owner only) batches the same work at 250 documents per Meilisearch task.
   Use `?reset=true` to discard prior backfill progress and re-scan from the
   start.

Watch Settings → Workers; `vectorizedDocumentCount` climbs back to
`indexedDocumentCount` as the re-embed proceeds.
```

- [ ] **Step 7: Format and commit**

```bash
./src/web/node_modules/.bin/prettier --write "src/api/src/enrichment/meilisearch-vector-coverage*.ts" docs/indexer-enrichment.md
```

```bash
git add src/api/src/enrichment/meilisearch-vector-coverage.ts src/api/src/enrichment/meilisearch-vector-coverage.test.ts docs/indexer-enrichment.md && git commit -m "fix(api): don't carry vector coverage across a document-shape change (#2384)"
```

---

## Task 5: Verbatim-query regression assertions

Enforces the issue's follow-up constraint: the exact submitted query must reach Meilisearch unchanged.

**Files:**

- Create: `src/api/tests/search-query-verbatim.test.ts`

**Interfaces:**

- Consumes: `createMeilisearchClient` from `meilisearch-client.ts`.
- Produces: nothing consumed downstream. This is a gate.

- [ ] **Step 1: Write the test**

Create `src/api/tests/search-query-verbatim.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { createMeilisearchClient } from '../src/enrichment/meilisearch-client.ts';

const FIXTURE_QUERY = 'HVAC air conditioning installation';

/** Capture the exact JSON body the client sends to Meilisearch. */
function capturingClient(sink: Array<Record<string, unknown>>) {
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    sink.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify({ hits: [], estimatedTotalHits: 0 }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return createMeilisearchClient({
    url: 'http://meili.test',
    semantic: true,
    embedderUrl: 'http://ollama.test',
    embedderModel: 'bge-m3',
    semanticRatio: 0.7,
    fetchImpl,
  });
}

describe('query verbatim contract (#2384)', () => {
  it('sends the submitted query byte-for-byte in hybrid mode', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).search(FIXTURE_QUERY, {
      semantic: true,
      limit: 20,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.q).toBe(FIXTURE_QUERY);
  });

  it('sends the submitted query byte-for-byte in lexical mode', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).search(FIXTURE_QUERY, {
      semantic: false,
      limit: 20,
    });
    expect(bodies[0]!.q).toBe(FIXTURE_QUERY);
  });

  it('adds no query-expansion knobs to the request body', () => {
    // Meilisearch would apply synonyms, stop-word stripping, or a rewritten
    // `q` only if we asked for them. Asserting on the exact key set means a
    // future "just add synonyms" change fails here instead of silently
    // violating the issue's verbatim-query constraint.
    const bodies: Array<Record<string, unknown>> = [];
    return capturingClient(bodies)
      .search(FIXTURE_QUERY, { semantic: true, limit: 20 })
      .then(() => {
        expect(Object.keys(bodies[0]!).sort()).toEqual([
          'attributesToRetrieve',
          'filter',
          'hybrid',
          'limit',
          'offset',
          'q',
          'showRankingScore',
        ]);
      });
  });

  it('preserves case and internal spacing exactly', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const odd = 'HVAC  air Conditioning  INSTALLATION';
    await capturingClient(bodies).search(odd, { semantic: true });
    expect(bodies[0]!.q).toBe(odd);
  });
});
```

Note for the reviewer: `service-asset-search.ts:266` applies `request.query.trim()` before this layer. That is the only normalisation in the path, it predates this work, and it is identity for the fixture query. It is deliberately left in place; the assertions above cover everything from the client boundary inward, where all ranking logic lives.

- [ ] **Step 2: Run it**

```bash
cd src/api && bun test tests/search-query-verbatim.test.ts
```

Expected: PASS immediately — this codifies existing behaviour so that any future change breaks it. If the key-set assertion fails, reconcile it against the current `searchRequest` in `meilisearch-client.ts:349` rather than loosening the assertion.

- [ ] **Step 3: Format and commit**

```bash
./src/web/node_modules/.bin/prettier --write src/api/tests/search-query-verbatim.test.ts
```

```bash
git add src/api/tests/search-query-verbatim.test.ts && git commit -m "test(api): assert the submitted query reaches Meilisearch verbatim (#2384)"
```

---

## Task 6: Relevance corpus, metrics, and the ranking gate

**Files:**

- Create: `src/api/src/enrichment/search-relevance-metrics.ts`
- Create: `src/api/src/enrichment/search-relevance-metrics.test.ts`
- Create: `src/api/tests/fixtures/search-relevance/corpus.json`
- Create: `src/api/tests/fixtures/search-relevance/queries.json`
- Create: `src/api/tests/fixtures/search-relevance/budgets.json`
- Create: `src/api/tests/search-relevance.integration.test.ts`
- Create: `src/scripts/test_search_relevance.sh`
- Create: `src/api/tools/export-search-corpus.ts`

**Interfaces:**

- Consumes: `MeilisearchAssetDoc` (Task 2), `createMeilisearchClient`.
- Produces:
  - `recallAtK(ranked: string[], relevant: string[], k: number): number`
  - `meanReciprocalRank(perQuery: Array<{ ranked: string[]; relevant: string[] }>): number`
  - the committed corpus + budgets that Task 7 tunes against.

- [ ] **Step 1: Write the failing metrics test**

Create `src/api/src/enrichment/search-relevance-metrics.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { meanReciprocalRank, recallAtK } from './search-relevance-metrics.ts';

describe('recallAtK', () => {
  it('is the fraction of relevant docs found in the top k', () => {
    expect(recallAtK(['a', 'b', 'c'], ['a', 'c'], 3)).toBe(1);
    expect(recallAtK(['a', 'x', 'y'], ['a', 'c'], 3)).toBe(0.5);
    expect(recallAtK(['x', 'y', 'a'], ['a'], 2)).toBe(0);
  });

  it('is 1 when nothing is labelled relevant (vacuously satisfied)', () => {
    expect(recallAtK(['a'], [], 10)).toBe(1);
  });
});

describe('meanReciprocalRank', () => {
  it('averages 1/rank of the first relevant hit', () => {
    expect(
      meanReciprocalRank([
        { ranked: ['a', 'b'], relevant: ['a'] },
        { ranked: ['x', 'b'], relevant: ['b'] },
      ]),
    ).toBeCloseTo(0.75, 10);
  });

  it('scores a query with no relevant hit as 0', () => {
    expect(meanReciprocalRank([{ ranked: ['x'], relevant: ['a'] }])).toBe(0);
  });

  it('is 0 for an empty evaluation set', () => {
    expect(meanReciprocalRank([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd src/api && bun test src/enrichment/search-relevance-metrics.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the metrics**

Create `src/api/src/enrichment/search-relevance-metrics.ts`:

```ts
/**
 * Ranking-quality metrics for the search relevance gate (#2384).
 *
 * Pure and dependency-free so they run in CI without a Meilisearch sidecar;
 * the env-gated integration test feeds them real result orders.
 */

/** Fraction of the labelled-relevant ids that appear in the top `k` results.
 * An unlabelled query is vacuously satisfied (returns 1) so a corpus entry
 * with no labels never drags the aggregate down. */
export function recallAtK(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  const found = relevant.filter((id) => top.has(id)).length;
  return found / relevant.length;
}

/** Reciprocal rank of the FIRST relevant hit; 0 when none is present. */
export function reciprocalRank(ranked: string[], relevant: string[]): number {
  const relevantSet = new Set(relevant);
  const index = ranked.findIndex((id) => relevantSet.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** Mean of `reciprocalRank` across an evaluation set. */
export function meanReciprocalRank(
  perQuery: Array<{ ranked: string[]; relevant: string[] }>,
): number {
  if (perQuery.length === 0) return 0;
  const total = perQuery.reduce((sum, q) => sum + reciprocalRank(q.ranked, q.relevant), 0);
  return total / perQuery.length;
}
```

- [ ] **Step 4: Run it to confirm it passes**

```bash
cd src/api && bun test src/enrichment/search-relevance-metrics.test.ts
```

Expected: PASS.

- [ ] **Step 5: Build the corpus fixture**

Create `src/api/tests/fixtures/search-relevance/corpus.json`. It is an array of `MeilisearchAssetDoc` objects. Seed it with the #2384 case plus deliberate distractors — the point of the distractors is that the generic HVAC-mentioning captions which currently outrank the video are **in** the corpus, so a regression reproduces. Start from this shape and extend to at least 30 documents:

```json
[
  {
    "id": "010045ca68ac1f7f7e8b3aa02f72ac80",
    "filename": "IMG_4185.MOV",
    "mediaType": "video",
    "description": "Interior view of a basement mechanical room with piping and equipment.",
    "transcript": "Alright so we just have the heat pumps installed downstairs. This is the Harmony 3 zone controller wired to the Lennox system. We replaced both condensate pumps and shortened the basement run so the line set is cleaner. The sensors and controllers are all mounted on the panel here.",
    "ocrText": null,
    "placeText": "12 Elm St, Albany, NY, USA",
    "people": null,
    "searchBlob": "3 albany basement cleaner condensate controller controllers harmony heat installed lennox line mechanical mounted panel pumps replaced room run sensors set shortened system view zone",
    "folderId": "64b64c16ab08e6c474227abc",
    "capturedAt": "2026-02-14T15:04:00Z",
    "deletedAt": null,
    "hidden": false
  },
  {
    "id": "distractor-rooftop-1",
    "filename": "IMG_2201.HEIC",
    "mediaType": "image",
    "description": "Rooftop HVAC units on a commercial building against a grey sky.",
    "transcript": null,
    "ocrText": null,
    "placeText": "Downtown Albany, NY, USA",
    "people": null,
    "searchBlob": "against albany building commercial grey hvac rooftop sky units",
    "folderId": "64b64c16ab08e6c474227abc",
    "capturedAt": "2026-01-02T12:00:00Z",
    "deletedAt": null,
    "hidden": false
  }
]
```

Add, at minimum, these further categories so the set cannot be satisfied by one query alone (acceptance criterion 5):

- 3–5 more generic HVAC-mentioning photo captions (rooftop units, a thermostat close-up, a compressor on a pad).
- 3 receipt/invoice screenshots with realistic `ocrText` (an HVAC service invoice, a hardware-store receipt, a utility bill) and `mediaType: "image"`.
- 2 installation-document scans with `ocrText` prose.
- 2 controller photos/videos (a thermostat with a visible model number; a short clip narrating a controller configuration).
- **Named-people set**, for the person-name guards in Step 6:
  - `person-greyson-1`, `person-greyson-2` — photos with `"people": ["Greyson Smith"]` and captions that do _not_ contain the name.
  - a distractor whose `transcript` says "…then Greyson showed up…" but whose `people` is `null`. This is what proves the ordering: the tagged photos must beat it.
  - `person-rose-1` — a photo with `"people": ["Rose Alvarez"]`, plus `flowers-roses-1`, a photo whose description is "Close-up of red roses in a garden bed" with `"people": null`. These two exist to feed the unasserted `Rose` observation in Step 6; **#2386** owns what should happen between them.
- ~15 unrelated documents (family photos, landscapes, pet videos with transcripts) as background noise.

Hand-authoring is the starting point; Step 9 adds the export script so the operator can grow this from their real index.

- [ ] **Step 6: Write the query labels**

Create `src/api/tests/fixtures/search-relevance/queries.json`:

```json
[
  {
    "query": "HVAC air conditioning installation",
    "relevantIds": ["010045ca68ac1f7f7e8b3aa02f72ac80"],
    "mustBeInTop": { "id": "010045ca68ac1f7f7e8b3aa02f72ac80", "k": 5 }
  },
  {
    "query": "IMG_4185.MOV",
    "relevantIds": ["010045ca68ac1f7f7e8b3aa02f72ac80"],
    "mustBeInTop": { "id": "010045ca68ac1f7f7e8b3aa02f72ac80", "k": 1 }
  },
  { "query": "heat pump receipt", "relevantIds": ["receipt-hvac-invoice"] },
  {
    "query": "thermostat controller model number",
    "relevantIds": ["controller-thermostat-1"]
  },
  {
    "query": "furnace installation paperwork",
    "relevantIds": ["install-doc-1"]
  },
  {
    "query": "Greyson",
    "relevantIds": ["person-greyson-1", "person-greyson-2"],
    "mustBeInTop": { "id": "person-greyson-1", "k": 3 }
  },
  {
    "query": "Rose",
    "relevantIds": [],
    "observeIds": ["person-rose-1", "flowers-roses-1"]
  }
]
```

Extend to cover every category added in Step 5. Two entries are hard guards rather than aggregate contributors:

- `IMG_4185.MOV` → top-1 is acceptance criterion 7 (exact filename behaviour intact).
- `Greyson` → top-3 is the named-person guard. A person's name must beat a transcript or OCR that merely mentions it; the corpus includes both a photo tagged with that person and a distractor whose transcript says the name in passing, so the assertion fails if `people` ever drops below `transcript`/`ocrText` in the attribute order.

The `Rose` entry is deliberately **unasserted** — `relevantIds` is empty so it contributes nothing to Recall@10 or MRR, and `observeIds` only asks the harness to print where each document landed. It captures the person-name-vs-common-noun collision (a photo tagged "Rose Alvarez" against a photo of roses) as measured data for **#2386**, which owns that decision. Deciding a winner here would mean tuning ranking against a case with no evidence behind it yet, which is exactly what this corpus exists to prevent. Do not add a `mustBeInTop` to it in this pass.

- [ ] **Step 7: Write the budgets**

Create `src/api/tests/fixtures/search-relevance/budgets.json`:

```json
{
  "_comment": "One-way ratchet, same convention as test-fixtures/budgets.json. Lower a floor only in the commit that delivers the improvement. Fill these in from the recorded BASELINE run (Step 10) before the gate is enabled.",
  "minRecallAt10": 0.0,
  "minMrr": 0.0,
  "semanticRatio": 0.7
}
```

Leave the floors at `0.0` in the first commit; Step 10 records the baseline and Step 11 sets them.

- [ ] **Step 8: Write the integration gate**

Create `src/api/tests/search-relevance.integration.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  createMeilisearchClient,
  type MeilisearchAssetDoc,
} from '../src/enrichment/meilisearch-client.ts';
import { meanReciprocalRank, recallAtK } from '../src/enrichment/search-relevance-metrics.ts';
import budgets from './fixtures/search-relevance/budgets.json';
import corpus from './fixtures/search-relevance/corpus.json';
import queries from './fixtures/search-relevance/queries.json';

const enabled = process.env.MAPLE_SEARCH_RELEVANCE === '1';
const meiliUrl = process.env.MAPLE_MEILISEARCH_INTEGRATION_URL;
const ollamaUrl = process.env.MAPLE_OLLAMA_INTEGRATION_URL;
const ratio = Number(process.env.MAPLE_SEMANTIC_RATIO ?? budgets.semanticRatio);

interface QueryCase {
  query: string;
  relevantIds: string[];
  mustBeInTop?: { id: string; k: number };
  /** Documents whose rank is printed in the report but NOT asserted on.
   * Used for cases owned by a different ticket — see the `Rose` entry and
   * #2386. Never gates. */
  observeIds?: string[];
}

describe('hybrid search relevance gate (#2384)', () => {
  it.skipIf(!enabled || !meiliUrl || !ollamaUrl)(
    'meets the committed Recall@10 / MRR floors and places the HVAC video in the top 5',
    async () => {
      const client = createMeilisearchClient({
        url: meiliUrl,
        semantic: true,
        embedderUrl: ollamaUrl!,
        embedderModel: 'bge-m3',
        semanticRatio: ratio,
        taskPollIntervalMs: 200,
        taskTimeoutMs: 15 * 60_000,
      });
      await client.ensureIndex();
      await client.upsertBatchOrThrow!(corpus as MeilisearchAssetDoc[]);

      const evaluated: Array<{ ranked: string[]; relevant: string[] }> = [];
      const report: Array<Record<string, unknown>> = [];

      for (const testCase of queries as QueryCase[]) {
        const result = await client.search(testCase.query, {
          semantic: true,
          limit: 50,
        });
        evaluated.push({ ranked: result.ids, relevant: testCase.relevantIds });
        report.push({
          query: testCase.query,
          recallAt10: recallAtK(result.ids, testCase.relevantIds, 10),
          topRank: result.ids.indexOf(testCase.relevantIds[0] ?? '') + 1,
          // Unasserted ranks for cases another ticket owns (#2386).
          ...(testCase.observeIds
            ? {
                observed: Object.fromEntries(
                  testCase.observeIds.map((id) => [id, result.ids.indexOf(id) + 1]),
                ),
              }
            : {}),
        });
      }

      const recall =
        evaluated.reduce((sum, e) => sum + recallAtK(e.ranked, e.relevant, 10), 0) /
        evaluated.length;
      const mrr = meanReciprocalRank(evaluated);
      console.error(
        JSON.stringify({ semanticRatio: ratio, recallAt10: recall, mrr, report }, null, 2),
      );

      for (const testCase of queries as QueryCase[]) {
        if (!testCase.mustBeInTop) continue;
        const result = await client.search(testCase.query, {
          semantic: true,
          limit: 50,
        });
        const rank = result.ids.indexOf(testCase.mustBeInTop.id) + 1;
        expect(rank).toBeGreaterThan(0);
        expect(rank).toBeLessThanOrEqual(testCase.mustBeInTop.k);
      }

      expect(recall).toBeGreaterThanOrEqual(budgets.minRecallAt10);
      expect(mrr).toBeGreaterThanOrEqual(budgets.minMrr);
    },
    20 * 60_000,
  );
});
```

- [ ] **Step 9: Write the harness wrapper and the corpus exporter**

Create `src/scripts/test_search_relevance.sh`:

```bash
#!/usr/bin/env bash
# Hybrid search relevance gate (#2384).
#
# Sibling of test_color_pipeline.sh: same skip-pass-without-fixtures shape,
# different subsystem. Needs a real Meilisearch and a real Ollama with the
# bge-m3 model pulled — there is no offline way to measure embedding
# relevance. Skip-passes (exit 0) when either is unconfigured so CI without a
# sidecar doesn't fail spuriously.
#
# Usage:
#   MAPLE_MEILISEARCH_INTEGRATION_URL=http://localhost:7700 \
#   MAPLE_OLLAMA_INTEGRATION_URL=http://localhost:11434 \
#   src/scripts/test_search_relevance.sh
#
#   MAPLE_SEMANTIC_RATIO=0.8 src/scripts/test_search_relevance.sh   # sweep one ratio

set -euo pipefail
cd "$(dirname "$0")/../api"

if [[ -z "${MAPLE_MEILISEARCH_INTEGRATION_URL:-}" || -z "${MAPLE_OLLAMA_INTEGRATION_URL:-}" ]]; then
  echo "MAPLE_MEILISEARCH_INTEGRATION_URL / MAPLE_OLLAMA_INTEGRATION_URL unset — skipping"
  exit 0
fi

MAPLE_SEARCH_RELEVANCE=1 bun test tests/search-relevance.integration.test.ts
```

```bash
chmod +x src/scripts/test_search_relevance.sh
```

Create `src/api/tools/export-search-corpus.ts` — the operator path for growing the corpus from a real deployment instead of hand-authoring:

```ts
/**
 * Export a sample of live Meilisearch asset documents as a relevance-corpus
 * fixture (#2384). Hand-authored corpora overfit; this pulls real documents,
 * including their real transcripts and captions, so the gate measures the
 * distribution the ranking actually faces.
 *
 * Usage:
 *   MAPLE_MEILISEARCH_URL=http://localhost:7700 \
 *     bun run tools/export-search-corpus.ts "HVAC air conditioning installation" 60 \
 *     > tests/fixtures/search-relevance/corpus.json
 *
 * Review the output before committing: it contains real filenames, captions,
 * transcripts, and place names from the operator's library.
 */

const url = process.env.MAPLE_MEILISEARCH_URL;
const apiKey = process.env.MAPLE_MEILISEARCH_API_KEY;
const query = Bun.argv[2] ?? '';
const limit = Number(Bun.argv[3] ?? 60);

if (!url) {
  console.error('MAPLE_MEILISEARCH_URL is required');
  process.exit(1);
}

const response = await fetch(`${url.replace(/\/$/, '')}/indexes/assets/search`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  },
  body: JSON.stringify({
    q: query,
    limit,
    filter: 'deletedAt IS NULL AND (hidden IS NULL OR hidden = false)',
  }),
});

if (!response.ok) {
  console.error(`meilisearch search failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const body = (await response.json()) as {
  hits: Array<Record<string, unknown>>;
};
const stripped = body.hits.map(({ _rankingScore, _formatted, ...doc }) => doc);
console.log(JSON.stringify(stripped, null, 2));
```

- [ ] **Step 10: Record the BASELINE — before the ranking changes**

This is acceptance criterion 6 and it must be measured against the **pre-change** configuration, so do it on a worktree checked out at the merge-base:

```bash
git stash && git checkout origin/main -- src/api/src/enrichment src/api/src/workers/stages/meili.ts
```

Bring up Meilisearch and Ollama (`ollama pull bge-m3` first), then:

```bash
MAPLE_MEILISEARCH_INTEGRATION_URL=http://localhost:7700 MAPLE_OLLAMA_INTEGRATION_URL=http://localhost:11434 src/scripts/test_search_relevance.sh 2>&1 | tee ~/Desktop/maple-color-tests/2384/baseline.json
```

Restore the branch (`git checkout . && git stash pop`) and record the numbers in the PR body under a **Baseline** heading. Expect the HVAC case to fail its top-5 assertion here — that failure IS the baseline evidence.

- [ ] **Step 11: Record the POST-CHANGE run and set the budgets**

```bash
MAPLE_MEILISEARCH_INTEGRATION_URL=http://localhost:7700 MAPLE_OLLAMA_INTEGRATION_URL=http://localhost:11434 src/scripts/test_search_relevance.sh 2>&1 | tee ~/Desktop/maple-color-tests/2384/after.json
```

Set `minRecallAt10` and `minMrr` in `budgets.json` to roughly 95% of the measured values — tight enough to catch a regression, loose enough not to fail on embedder nondeterminism. Record both runs in the PR body.

If the HVAC case still misses the top 5 here, **stop and do not lower the assertion**. Go to Task 7 and treat it as the reranker trigger.

- [ ] **Step 12: Format and commit**

```bash
./src/web/node_modules/.bin/prettier --write "src/api/src/enrichment/search-relevance-metrics*.ts" "src/api/tests/search-relevance.integration.test.ts" "src/api/tests/fixtures/search-relevance/*.json" "src/api/tools/export-search-corpus.ts"
```

```bash
git add src/api/src/enrichment/search-relevance-metrics.ts src/api/src/enrichment/search-relevance-metrics.test.ts src/api/tests/search-relevance.integration.test.ts src/api/tests/fixtures/search-relevance src/api/tools/export-search-corpus.ts src/scripts/test_search_relevance.sh && git commit -m "test(api): relevance corpus, Recall@10/MRR metrics, and ranking gate (#2384)"
```

---

## Task 7: Blend-ratio sweep, docs, and the reranker decision gate

**Files:**

- Modify: `src/api/src/enrichment/meilisearch-config.ts` (only if the sweep shows a better default)
- Modify: `src/api/tests/fixtures/search-relevance/budgets.json` (`semanticRatio`)
- Modify: `docs/indexer-enrichment.md`

**Interfaces:**

- Consumes: the harness from Task 6.
- Produces: the chosen `DEFAULT_MEILISEARCH_SEMANTIC_RATIO` and the go/no-go decision on the reranker.

- [ ] **Step 1: Sweep the ratios**

```bash
for r in 0.50 0.60 0.70 0.80; do MAPLE_SEMANTIC_RATIO=$r MAPLE_MEILISEARCH_INTEGRATION_URL=http://localhost:7700 MAPLE_OLLAMA_INTEGRATION_URL=http://localhost:11434 src/scripts/test_search_relevance.sh 2>&1 | tee ~/Desktop/maple-color-tests/2384/sweep-$r.json; done
```

The current shipped default is `0.5` (`meilisearch-config.ts:5`). Pick the ratio with the best aggregate MRR **across the whole query set** — not the one that best serves the HVAC query. If two ratios are within noise, keep the lower one: more lexical weight preserves exact-filename behaviour, which is a hard acceptance criterion.

- [ ] **Step 2: Apply the chosen ratio**

If the sweep favours a different default, change `DEFAULT_MEILISEARCH_SEMANTIC_RATIO` in `src/api/src/enrichment/meilisearch-config.ts` and set the same value as `semanticRatio` in `budgets.json`. No new setting is needed — `meilisearch_semantic_ratio` is already DB-backed (`enrichment-config.resolve.ts:91`) and already has a control on Settings → Workers (`workers.vm.ts:275`), so operators can override the default at runtime. Do not add an environment variable.

- [ ] **Step 3: Re-run the full gate at the chosen ratio**

```bash
MAPLE_MEILISEARCH_INTEGRATION_URL=http://localhost:7700 MAPLE_OLLAMA_INTEGRATION_URL=http://localhost:11434 src/scripts/test_search_relevance.sh
```

Expected: PASS, including the HVAC top-5 and the `IMG_4185.MOV` top-1 assertions.

- [ ] **Step 4: Update the docs**

In `docs/indexer-enrichment.md`, in the Meilisearch section, document: the field list on `MeilisearchAssetDoc` including `transcript`/`placeText`; the labelled embedder template and why `searchBlob` is excluded from it; the searchable-attribute order and what it weights; and how to run `src/scripts/test_search_relevance.sh`.

- [ ] **Step 5: The reranker decision gate**

Read the Task 6 Step 11 / Task 7 Step 3 numbers and take one of two branches:

- **The gate passes.** The reranker is not built. Record in the PR body: the baseline vs post-change Recall@10 / MRR, the HVAC rank before and after, and one line stating that issue item 6 was evaluated and not needed. File nothing.
- **The gate fails** — the HVAC case still misses the top 5, or aggregate MRR is below the baseline on any category. Open a follow-up ticket with `gh issue create`, add it to the **Files** project board, and paste the measured numbers into it. Scope it to what the measurement showed is missing, drawn from the issue's item 6 list: over-fetch 50–100 candidates from Meilisearch and rerank on transcript semantic similarity, near-phrase matching, action-verb matching (installed/replaced/repaired/configured), and source strength (transcript evidence vs generic caption). The verbatim-query constraint applies to the reranker too — Task 5's assertions must be extended to cover the reranker's input. Meilisearch stays the candidate retriever; MongoDB stays the source of truth. Reference the new ticket number in the #2384 PR body so the staging is explicit and tracked, per CLAUDE.md principle 6.

- [ ] **Step 6: Full verification before the PR**

```bash
cd src/api && bun test
```

```bash
tools/check-file-budget.sh src/api/src
```

```bash
cd src/web && bun run format:check
```

- [ ] **Step 7: Commit and open the PR**

```bash
git add -u && git commit -m "docs(api): document transcript-aware search fields and the relevance harness (#2384)"
```

Open the PR **ready for review, not draft**. Body must include `Closes #2384`, the baseline and post-change metric tables, the chosen semantic ratio with its justification, and the reranker decision from Step 5.

---

## Sequencing and parallelism

Tasks 1 → 2 → 3 → 4 are strictly ordered: each depends on the previous one's exports. Task 5 is fully independent and can be done by a second worker at any time. Task 6's Steps 1–4 (the pure metrics module) are also independent; Steps 5–11 need Tasks 1–4 landed. Task 7 needs Task 6.

## Verification summary

| Acceptance criterion (from #2384)                                         | Where it is satisfied                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcript is a dedicated indexed/searchable field                        | Task 2 (document field, both writers) + Task 3 (searchable attribute, position 3)                                                                                                                                          |
| Named-person queries rank tagged photos strongly (raised in review)       | Task 3 (`people` at position 2, above transcript/OCR/description) + Task 6 `Greyson` top-3 guard. The name-vs-common-noun collision is explicitly **out of scope**, owned by #2386, and recorded unasserted in the corpus. |
| Embedding template does not duplicate description                         | Task 3 Step 1 asserts `searchBlob` is absent from the template                                                                                                                                                             |
| Template/settings changes invalidate coverage and support a full re-embed | Task 1 (single-sourced fingerprint) + Task 4 (shape-gated carry-forward, documented operator procedure)                                                                                                                    |
| Ranking fixture puts `IMG_4185.MOV` in the top 5 for the HVAC query       | Task 6 `queries.json` `mustBeInTop: { k: 5 }`                                                                                                                                                                              |
| Additional archive-search fixtures prevent overfitting                    | Task 6 Step 5 categories (receipts, installation documents, controller photos/videos, noise) + Step 6 labels                                                                                                               |
| Baseline and post-change Recall@10 / MRR recorded                         | Task 6 Steps 10–11                                                                                                                                                                                                         |
| Exact filename search behaviour intact                                    | `filename` stays first in `searchableAttributes` (Task 3); `IMG_4185.MOV` top-1 assertion (Task 6)                                                                                                                         |
| Lexical fallback intact when the embedder is unavailable                  | Untouched by this plan; Task 5 asserts the lexical path sends the verbatim query, and `bun test tests/service-asset-search.test.ts` covers the fallback chain                                                              |
| Query preserved verbatim (issue comment)                                  | Task 5                                                                                                                                                                                                                     |
| No SugarMaple protocol change                                             | Nothing in this plan touches the `/api/search/assets` request or response shape                                                                                                                                            |
