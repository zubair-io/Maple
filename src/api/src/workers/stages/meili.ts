/**
 * Meili (search-blob) stage. Fan-in terminal stage.
 *
 * Depends on all enrichment stages. Once they are all at version >= 1, this
 * stage reads the assembled image doc and writes the unified search document
 * to Meilisearch. Returns `{ wrote: true }` — the runtime bumps
 * `stages.meili.version` but does not merge a patch into the image doc.
 *
 * Throws on Meilisearch transport error so the runtime retries. A Meilisearch
 * outage does not block enrichment stages — they complete independently.
 * Meili simply retries up to `maxAttempts` and dead-letters if Meilisearch
 * is unreachable for a sustained period.
 *
 * When `maple_id` is absent (legacy row pre-dating the indexer's mapleId
 * migration), returns `{ wrote: true }` and skips the upsert so the stage
 * completes rather than spinning forever on an un-fixable invariant violation.
 */

import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { meilisearchClient, type MeilisearchClient } from "../../enrichment/meilisearch-client.ts";
import { composeSearchBlob } from "../../enrichment/search-blob.ts";

export async function meiliHandler(
  image: ImageDoc,
  ctx: StageContext & { meilisearch?: MeilisearchClient },
): Promise<StageResult> {
  const client = ctx.meilisearch ?? meilisearchClient();
  const mapleId = (image as unknown as { maple_id?: string }).maple_id ?? "";
  if (mapleId.length === 0) {
    return { wrote: true };
  }
  const searchBlob = composeSearchBlob({
    place: image.place,
    description: image.description,
    ocrText: (image as unknown as { ocr_text?: string }).ocr_text ?? null,
  });
  await client.upsert({
    id: mapleId,
    searchBlob,
    description: image.description ?? null,
    ocrText: (image as unknown as { ocr_text?: string }).ocr_text ?? null,
    folderId: image.folder_id.toHexString(),
    capturedAt: image.exif?.captured_at ?? null,
    deletedAt: null,
  });
  return { wrote: true };
}

export default defineStage({
  name: "meili",
  targetVersion: 1,
  dependsOn: ["exif", "thumb", "face", "ocr", "describe", "geocode"],
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
