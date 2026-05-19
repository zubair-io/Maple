/**
 * Meili (search-blob) stage. Fan-in terminal stage.
 *
 * Depends on the always-on stages only (exif, thumb). When optional stages
 * (face/ocr/describe/geocode) run later, meili won't automatically re-process
 * to incorporate their outputs. Operator must bump meili.targetVersion or
 * trigger a manual reset to refresh.
 *
 * The `search_blob` patch keeps the Mongo `$text` fallback search coherent
 * so assets remain searchable even without a Meilisearch sidecar.
 *
 * When Meilisearch is configured, the doc is also upserted there for
 * typo-tolerant search. Throws on transport error so the runtime retries.
 *
 * When `maple_id` is absent (legacy row pre-dating the indexer's mapleId
 * migration), returns `{ skip: "no-maple-id" }` so the stage completes
 * rather than spinning forever on an un-fixable invariant violation.
 */

import type { ImageDoc, StageContext, StageResult } from "../run-stage.ts";
import { defineStage, runStage, type RunStageHandle } from "../run-stage.ts";
import { meilisearchClient, type MeilisearchClient } from "../../enrichment/meilisearch-client.ts";
import { composeSearchBlob } from "../../enrichment/search-blob.ts";

let _client: MeilisearchClient | null = null;
function getClient(): MeilisearchClient {
  if (!_client) _client = meilisearchClient();
  return _client;
}

/** Test-only setter. Call with `null` to reset between tests. */
export function setMeilisearchClientForTests(client: MeilisearchClient | null): void {
  _client = client;
}

export async function meiliHandler(
  image: ImageDoc,
  _ctx: StageContext,
): Promise<StageResult> {
  const mapleId = (image as unknown as { maple_id?: string }).maple_id ?? "";
  if (mapleId.length === 0) {
    return { skip: "no-maple-id" };
  }

  const blob = composeSearchBlob({
    place: image.place,
    description: image.description,
    ocrText: (image as unknown as { ocr_text?: string }).ocr_text ?? null,
  });

  const client = getClient();
  if (client.isConfigured()) {
    await client.upsertOrThrow({
      id: mapleId,
      searchBlob: blob,
      description: image.description ?? null,
      ocrText: (image as unknown as { ocr_text?: string }).ocr_text ?? null,
      folderId: image.folder_id.toHexString(),
      capturedAt: image.exif?.captured_at ?? null,
      deletedAt: null,
    });
  }

  return { patch: { search_blob: blob } };
}

const meiliStage = defineStage({
  name: "meili",
  // v2: ocr v2 introduces a mean-confidence gate that blanks `ocr_text` on
  // textureless photos. Without bumping meili too, the search index keeps
  // the pre-gate (poisoned) text for rows already meili'd at v1. Bumping
  // here forces a re-index against the cleaned ocr_text.
  targetVersion: 2,
  // Only depends on always-on stages. When optional stages (face/ocr/describe/geocode)
  // run later, meili won't automatically re-process to incorporate their outputs.
  // Operator must bump meili.targetVersion or trigger a manual reset to refresh.
  dependsOn: ["exif", "thumb"],
  defaults: {
    concurrency: 2,
    pollIntervalMs: 1000,
    batchSize: 20,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: false,
  },
  handler: meiliHandler,
});

export default meiliStage;

export async function startMeiliStage(): Promise<RunStageHandle> {
  return runStage(meiliStage);
}
