import { describe, expect, it } from "bun:test";
import type { Db, Collection } from "mongodb";

// Hand-rolled stub for Db that tracks createIndex calls per collection.
// ensureStageIndexes only calls db.collection(name).createIndex — we stub that.

interface IndexSpec {
  key: Record<string, unknown>;
  options: Record<string, unknown>;
}

function makeDbStub(): { db: Db; getIndexes: (collName: string) => IndexSpec[] } {
  const collIndexes = new Map<string, IndexSpec[]>();

  function collStub(name: string): Collection {
    if (!collIndexes.has(name)) collIndexes.set(name, []);
    return {
      async createIndex(key: Record<string, unknown>, options: Record<string, unknown> = {}) {
        collIndexes.get(name)!.push({ key, options });
        return options["name"] as string ?? JSON.stringify(key);
      },
    } as unknown as Collection;
  }

  return {
    db: {
      collection: collStub,
    } as unknown as Db,
    getIndexes: (n: string) => collIndexes.get(n) ?? [],
  };
}

const STAGE_NAMES = ["hash", "exif", "thumb", "face", "ocr", "describe", "geocode", "meili"];

describe("ensureStageIndexes", () => {
  it("creates a partial index for each known stage", async () => {
    const { db, getIndexes } = makeDbStub();
    const { ensureStageIndexes } = await import("../../db/client.ts");
    await ensureStageIndexes(db);
    const indexes = getIndexes("assets");
    for (const name of STAGE_NAMES) {
      const found = indexes.find(
        (idx) =>
          idx.key[`stages.${name}.version`] === 1 &&
          (idx.options["partialFilterExpression"] as Record<string, unknown>)?.[
            `stages.${name}.dead`
          ] !== undefined,
      );
      expect(found).toBeDefined();
    }
  });

  it("is idempotent — calling twice does not throw", async () => {
    const { db } = makeDbStub();
    const { ensureStageIndexes } = await import("../../db/client.ts");
    await ensureStageIndexes(db);
    await expect(ensureStageIndexes(db)).resolves.toBeUndefined();
  });
});
