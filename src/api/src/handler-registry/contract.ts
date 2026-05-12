/**
 * Stage-handler wire contract.
 *
 * Versioned JSON-in/JSON-out shapes passed to external (HTTP) implementations
 * of an indexer pipeline stage. Deliberately narrower than `PipelineJob` so
 * external implementations are not coupled to internal types — the adapter
 * (see `pipeline.ts: runAi`) is responsible for projecting the job onto the
 * input and merging the output back.
 *
 * `contractVersion` is mandatory on both directions. Bump it whenever fields
 * are removed or change meaning; new optional fields can be added at the
 * current version.
 *
 * Today only `ai` is wired. New stages would add their own
 * `*Input` / `*Output` shapes here.
 */

import type { AssetExif, Bbox } from "../db/schema.ts";

/**
 * Face detection output from the ai stage.
 * Previously imported from indexer/pipeline.ts (now deleted).
 */
export interface AiFace {
  /** Bounding box in normalised [0..1] image coordinates. */
  bbox: Bbox;
  /** Optional linked person id (MongoDB ObjectId hex) — null until reviewer confirms. */
  personId: string | null;
  /** Detector confidence in [0..1]. */
  confidence: number;
  /** MobileFaceNet 512-D embedding. Omitted for pass-through today. */
  embedding?: Float32Array;
}

export const CONTRACT_VERSION = 1 as const;

/** Input passed to an `ai`-stage external handler. */
export interface AiHandlerInput {
  contractVersion: typeof CONTRACT_VERSION;
  stage: "ai";
  mapleId: string;
  absPath: string;
  /** EXIF subdoc as parsed by the exif stage. May be null when the parse failed. */
  exif: AssetExif | null;
  /** Path to the on-disk thumbnail, when available. */
  thumbPath?: string;
}

/** Output the handler must return. */
export interface AiHandlerOutput {
  contractVersion: typeof CONTRACT_VERSION;
  faces: AiFace[];
  aiTags: string[];
}

/**
 * Validate (lightly) that an unknown JSON value matches `AiHandlerOutput`.
 * Throws on schema drift so the pipeline's `withRetry` can surface the error.
 *
 * The check is intentionally shallow: contract version + array shape. Field
 * coercion (e.g. converting bbox numbers) is the caller's responsibility.
 */
export function parseAiOutput(value: unknown): AiHandlerOutput {
  if (!value || typeof value !== "object") {
    throw new Error("[handler-registry] response is not a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.contractVersion !== CONTRACT_VERSION) {
    throw new Error(
      `[handler-registry] response missing/unsupported contractVersion (got ${String(obj.contractVersion)}, expected ${CONTRACT_VERSION})`
    );
  }
  if (!Array.isArray(obj.faces)) {
    throw new Error("[handler-registry] response.faces is not an array");
  }
  if (!Array.isArray(obj.aiTags) || !obj.aiTags.every((t) => typeof t === "string")) {
    throw new Error("[handler-registry] response.aiTags is not a string array");
  }
  return {
    contractVersion: CONTRACT_VERSION,
    faces: obj.faces as AiFace[],
    aiTags: obj.aiTags as string[],
  };
}
