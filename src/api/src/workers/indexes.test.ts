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
      async dropIndex(_indexName: string) {
        // Simulate a no-op drop — the stub has no pre-existing indexes.
        // The production code swallows IndexNotFound, so this is fine.
      },
      async indexes() {
        return (collIndexes.get(name) ?? []).map((i) => ({
          key: i.key,
          ...i.options,
        }));
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

const STAGE_NAMES = ["hash", "exif", "thumb", "preview", "face", "describe", "geocode", "meili"];

describe("ensureStageIndexes", () => {
  it("creates a version index for each known stage (no partial filter)", async () => {
    const { db, getIndexes } = makeDbStub();
    const { ensureStageIndexes } = await import("../db/client.ts");
    await ensureStageIndexes(db);
    const indexes = getIndexes("assets");
    for (const name of STAGE_NAMES) {
      const found = indexes.find(
        (idx) =>
          idx.key[`stages.${name}.version`] === 1 &&
          idx.options["name"] === `stage_${name}_version`,
      );
      expect(found).toBeDefined();
      expect(found?.options["partialFilterExpression"]).toBeUndefined();
    }
  });

  it("is idempotent — calling twice does not throw", async () => {
    const { db } = makeDbStub();
    const { ensureStageIndexes } = await import("../db/client.ts");
    await ensureStageIndexes(db);
    await expect(ensureStageIndexes(db)).resolves.toBeUndefined();
  });
});
