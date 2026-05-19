import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import hashStage from "./hash.ts";

// Build a minimal image doc with enough fields for the handler.
function makeDoc(absPath: string) {
  return {
    _id: "000000000000000000000001" as unknown as import("mongodb").ObjectId,
    abs_path: absPath,
    stages: {
      hash:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      exif:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      thumb:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      face:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      geocode:  { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      meili:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  };
}

describe("hash handler", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "hash-stage-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a patch containing sha1_head, size, mtime, and maple_id", async () => {
    const file = path.join(dir, "test.jpg");
    // 1 KB of deterministic bytes so sha1 is stable.
    const content = Buffer.alloc(1024, 0xab);
    await writeFile(file, content);

    const doc = makeDoc(file);
    const result = await hashStage.handler(doc as never, {} as never);

    expect("patch" in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };

    expect(typeof patch.sha1_head).toBe("string");
    expect((patch.sha1_head as string).length).toBe(40); // hex SHA-1
    expect(typeof patch.size).toBe("number");
    expect((patch.size as number)).toBe(1024);
    expect(typeof patch.mtime).toBe("number");
    expect(typeof patch.maple_id).toBe("string");
    expect((patch.maple_id as string).length).toBe(32); // 16 bytes hex
  });

  it("sha1_head is deterministic for identical content", async () => {
    const fileA = path.join(dir, "a.jpg");
    const fileB = path.join(dir, "b.jpg");
    const content = Buffer.alloc(512, 0x77);
    await writeFile(fileA, content);
    await writeFile(fileB, content);

    const [rA, rB] = await Promise.all([
      hashStage.handler(makeDoc(fileA) as never, {} as never),
      hashStage.handler(makeDoc(fileB) as never, {} as never),
    ]);
    const pA = (rA as { patch: Record<string, unknown> }).patch;
    const pB = (rB as { patch: Record<string, unknown> }).patch;
    expect(pA.sha1_head).toBe(pB.sha1_head);
    expect(pA.maple_id).toBe(pB.maple_id);
  });

  it("throws when the file does not exist", async () => {
    const doc = makeDoc(path.join(dir, "no-such-file.jpg"));
    await expect(hashStage.handler(doc as never, {} as never)).rejects.toThrow();
  });
});
