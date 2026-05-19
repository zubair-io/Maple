/**
 * Hash stage — reads the first 64 KB of the source file, computes SHA-1,
 * stats the file, and derives the maple:id in fallback form (tag 0x02).
 *
 * The primary form (tag 0x01, needs EXIF capturedAt + camera serial) is
 * finalised by the exif stage after `readExif` populates those fields.
 * That upgrade is a $set on the existing row; downstream stages key on
 * `abs_path`, not `maple_id`, so the late finalisation is safe.
 *
 * dependsOn: []   — first stage in the graph; no prerequisites.
 */
import * as fs from "node:fs/promises";
import { sha1 } from "@noble/hashes/legacy.js";
import { deriveId } from "../../indexer/id.ts";
import { defineStage, runStage, type RunStageHandle } from "../run-stage.ts";

const SHA1_HEAD_BYTES = 64 * 1024;

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

async function readHead(absPath: string): Promise<Uint8Array> {
  const fd = await fs.open(absPath, "r");
  try {
    const buf = new Uint8Array(SHA1_HEAD_BYTES);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

const hashStage = defineStage({
  name: "hash",
  targetVersion: 1,
  dependsOn: [],
  defaults: {
    concurrency: 4,
    batchSize: 10,
    pollIntervalMs: 1000,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: false,
    last_seen_target_version: 0,
  },
  handler: async (image) => {
    const absPath = image.abs_path as string;
    const [head, stat] = await Promise.all([readHead(absPath), fs.stat(absPath)]);
    const sha1HeadHex = toHex(sha1(head));
    // Derive fallback-form id now; the exif stage will upgrade to primary if
    // capturedAt is available.
    // NOTE: deriveId(head, null, null, null) calls fallback(head, head.length)
    // internally, using the head buffer length (≤ 64 KB) as the filesize
    // substitute. This is intentional — the real stat.size is stored in the
    // patch for display purposes, but the id derivation uses head.length for
    // byte-for-byte parity with the Rust fallback form. The exif stage
    // upgrades to primary form (which uses sha1(head)||capturedAt) when
    // capturedAt is present, superseding this fallback.
    const id = deriveId(head, null, null, null);
    return {
      patch: {
        sha1_head: sha1HeadHex,
        size: stat.size,
        mtime: stat.mtimeMs,
        maple_id: id.hex,
      },
    };
  },
});

export default hashStage;

export async function startHashStage(): Promise<RunStageHandle> {
  return runStage(hashStage);
}
