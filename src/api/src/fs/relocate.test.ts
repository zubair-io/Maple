/**
 * Integration tests for the generic crash-safe relocate primitive (#2629).
 *
 * Real temp directories, real files, real sidecars — no mocks for the
 * filesystem or sidecar layer (repo rule: "No mocks for the sidecar layer
 * in tests" — XMP is the contract, mocks let bugs through).
 *
 * Covers, per the ticket's acceptance criteria: collision in each
 * resolution mode, sidecar-follow, copy-vs-move, and a crash-mid-copy
 * simulation proving the source survives.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { relocateFile, pickFreePath, sidecarRenameTarget } from "./relocate.ts";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relocate-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<string> {
  const target = path.join(root, ...rel.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}
function abs(rel: string): string {
  return path.join(root, ...rel.split("/"));
}
async function exists(rel: string): Promise<boolean> {
  try {
    await fs.stat(abs(rel));
    return true;
  } catch {
    return false;
  }
}
async function read(rel: string): Promise<string> {
  return fs.readFile(abs(rel), "utf8");
}
/** No file at `rel` has a `.tmp.` sibling left behind — a leaked temp would
 * mean a failed relocate didn't clean up after itself. */
async function hasNoTempLitter(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(root, dir));
  } catch {
    return;
  }
  expect(entries.some((n) => n.includes(".tmp."))).toBe(false);
}

// ---------------------------------------------------------------------------
// copy vs move
// ---------------------------------------------------------------------------

describe("relocateFile — mode: move vs copy", () => {
  test("move: source is deleted, destination has the content", async () => {
    await write("src/IMG_1.dng", "pixels");
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "move",
      collision: "auto-suffix",
    });
    expect(outcome.kind).toBe("relocated");
    expect(await exists("src/IMG_1.dng")).toBe(false);
    expect(await exists("dst/IMG_1.dng")).toBe(true);
    expect(await read("dst/IMG_1.dng")).toBe("pixels");
    await hasNoTempLitter("dst");
  });

  test("copy: source AND destination both hold the content", async () => {
    await write("src/IMG_1.dng", "pixels");
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "copy",
      collision: "auto-suffix",
    });
    expect(outcome.kind).toBe("relocated");
    expect(await exists("src/IMG_1.dng")).toBe(true);
    expect(await read("src/IMG_1.dng")).toBe("pixels");
    expect(await exists("dst/IMG_1.dng")).toBe(true);
    expect(await read("dst/IMG_1.dng")).toBe("pixels");
  });
});

// ---------------------------------------------------------------------------
// Sidecar follow
// ---------------------------------------------------------------------------

describe("relocateFile — sidecar follow", () => {
  test("the canonical .xmp sidecar follows the primary on move", async () => {
    await write("src/IMG_1.dng", "pixels");
    await write("src/IMG_1.xmp", "edits");
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "move",
      collision: "auto-suffix",
    });
    expect(outcome.kind).toBe("relocated");
    if (outcome.kind !== "relocated") return;
    expect(outcome.sidecarPaths).toEqual([abs("dst/IMG_1.xmp")]);
    expect(await exists("dst/IMG_1.xmp")).toBe(true);
    expect(await read("dst/IMG_1.xmp")).toBe("edits");
    expect(await exists("src/IMG_1.xmp")).toBe(false);
  });

  test("collision auto-suffix renames the primary AND both sidecars consistently", async () => {
    await write("dst/IMG_1.dng", "occupant"); // pre-existing occupant forces a .1 suffix
    await write("src/IMG_1.dng", "pixels");
    await write("src/IMG_1.xmp", "edits");
    await write("src/IMG_1 (conflict from iPhone).xmp", "other-device-edits");

    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "move",
      collision: "auto-suffix",
    });
    expect(outcome.kind).toBe("relocated");
    if (outcome.kind !== "relocated") return;
    expect(outcome.newAbsPath).toBe(abs("dst/IMG_1.1.dng"));
    expect(outcome.renamedOnCollision).toBe(true);
    expect(await read("dst/IMG_1.1.dng")).toBe("pixels");
    expect(await read("dst/IMG_1.1.xmp")).toBe("edits");
    expect(await read("dst/IMG_1.1 (conflict from iPhone).xmp")).toBe(
      "other-device-edits",
    );
    // Pre-existing occupant untouched.
    expect(await read("dst/IMG_1.dng")).toBe("occupant");
    // Sources gone (move mode).
    expect(await exists("src/IMG_1.dng")).toBe(false);
    expect(await exists("src/IMG_1.xmp")).toBe(false);
    expect(await exists("src/IMG_1 (conflict from iPhone).xmp")).toBe(false);
  });

  test("a video keeps its full-name .mov.xmp sidecar distinct from a same-stem photo sidecar", async () => {
    // Live Photo pairing safety: IMG_1.HEIC + IMG_1.xmp are independent from
    // IMG_1.MOV + IMG_1.MOV.xmp — moving the MOV must not touch the photo's sidecar.
    await write("src/IMG_1.HEIC", "still");
    await write("src/IMG_1.xmp", "still-edits");
    await write("src/IMG_1.MOV", "clip");
    await write("src/IMG_1.MOV.xmp", "clip-edits");

    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.MOV"),
      destAbsPath: abs("dst/IMG_1.MOV"),
      mode: "move",
      collision: "auto-suffix",
    });
    expect(outcome.kind).toBe("relocated");
    expect(await exists("dst/IMG_1.MOV.xmp")).toBe(true);
    expect(await read("dst/IMG_1.MOV.xmp")).toBe("clip-edits");
    // The still + its sidecar are completely untouched.
    expect(await exists("src/IMG_1.HEIC")).toBe(true);
    expect(await exists("src/IMG_1.xmp")).toBe(true);
    expect(await read("src/IMG_1.xmp")).toBe("still-edits");
  });

  test("a sidecar copy failure is logged and left in place — never blocks or reverts the primary", async () => {
    await write("src/IMG_1.dng", "pixels");
    const sidecarAbs = await write("src/IMG_1.xmp", "edits");
    // Make the sidecar unreadable so its copy step throws — simulate a
    // permissions failure independent of the primary's copy.
    await fs.chmod(sidecarAbs, 0o000);
    try {
      const outcome = await relocateFile({
        sourceAbsPath: abs("src/IMG_1.dng"),
        destAbsPath: abs("dst/IMG_1.dng"),
        mode: "move",
        collision: "auto-suffix",
      });
      expect(outcome.kind).toBe("relocated");
      if (outcome.kind !== "relocated") return;
      expect(outcome.sidecarPaths).toEqual([]);
      // Primary still relocated successfully.
      expect(await exists("dst/IMG_1.dng")).toBe(true);
      expect(await exists("src/IMG_1.dng")).toBe(false);
      // Sidecar left in place at its ORIGINAL location, untouched.
      expect(await exists("src/IMG_1.xmp")).toBe(true);
    } finally {
      await fs.chmod(sidecarAbs, 0o644).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Collision resolution — one test per policy
// ---------------------------------------------------------------------------

describe("relocateFile — collision policies", () => {
  test("'auto-suffix': picks the next free .N sibling", async () => {
    await write("dst/IMG_1.dng", "occupant");
    await write("src/IMG_1.dng", "pixels");
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "move",
      collision: "auto-suffix",
    });
    expect(outcome.kind).toBe("relocated");
    if (outcome.kind !== "relocated") return;
    expect(outcome.newAbsPath).toBe(abs("dst/IMG_1.1.dng"));
    expect(outcome.renamedOnCollision).toBe(true);
    expect(await read("dst/IMG_1.dng")).toBe("occupant"); // untouched
  });

  test("'keep-both': same mechanics as auto-suffix, explicit user intent", async () => {
    await write("dst/IMG_1.dng", "occupant");
    await write("src/IMG_1.dng", "pixels");
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "move",
      collision: "keep-both",
    });
    expect(outcome.kind).toBe("relocated");
    if (outcome.kind !== "relocated") return;
    expect(outcome.newAbsPath).toBe(abs("dst/IMG_1.1.dng"));
    expect(await read("dst/IMG_1.dng")).toBe("occupant");
    expect(await read("dst/IMG_1.1.dng")).toBe("pixels");
  });

  test("'skip': declines when occupied, source untouched, nothing written", async () => {
    await write("dst/IMG_1.dng", "occupant");
    await write("src/IMG_1.dng", "pixels");
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "move",
      collision: "skip",
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "collision" });
    expect(await read("src/IMG_1.dng")).toBe("pixels"); // source untouched
    expect(await read("dst/IMG_1.dng")).toBe("occupant"); // occupant untouched
  });

  test("'skip': proceeds normally when nothing occupies the destination", async () => {
    await write("src/IMG_1.dng", "pixels");
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "move",
      collision: "skip",
    });
    expect(outcome.kind).toBe("relocated");
    expect(await exists("dst/IMG_1.dng")).toBe(true);
  });

  test("'replace': overwrites the occupant, source deleted on move", async () => {
    await write("dst/IMG_1.dng", "stale-occupant");
    await write("src/IMG_1.dng", "fresh-pixels");
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "move",
      collision: "replace",
    });
    expect(outcome.kind).toBe("relocated");
    if (outcome.kind !== "relocated") return;
    expect(outcome.newAbsPath).toBe(abs("dst/IMG_1.dng"));
    expect(outcome.renamedOnCollision).toBe(false);
    expect(await read("dst/IMG_1.dng")).toBe("fresh-pixels");
    expect(await exists("src/IMG_1.dng")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failure direction: any failure before delete leaves the original untouched
// ---------------------------------------------------------------------------

describe("relocateFile — crash-mid-relocate leaves the source untouched", () => {
  test("onVerified throwing (simulating a DB-repoint crash) reverts every copy and leaves the source intact", async () => {
    await write("src/IMG_1.dng", "pixels");
    await write("src/IMG_1.xmp", "edits");

    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "move",
      collision: "auto-suffix",
      onVerified: async () => {
        throw new Error("simulated crash: DB repoint failed mid-relocate");
      },
    });

    expect(outcome.kind).toBe("error");
    // The load-bearing invariant: source primary AND sidecar are fully
    // intact, byte-for-byte, exactly as if nothing had ever run.
    expect(await exists("src/IMG_1.dng")).toBe(true);
    expect(await read("src/IMG_1.dng")).toBe("pixels");
    expect(await exists("src/IMG_1.xmp")).toBe(true);
    expect(await read("src/IMG_1.xmp")).toBe("edits");
    // Every copy made before the crash was reverted — no orphan at dest.
    expect(await exists("dst/IMG_1.dng")).toBe(false);
    expect(await exists("dst/IMG_1.xmp")).toBe(false);
    await hasNoTempLitter("dst");
  });

  test("onVerified throwing during a COPY (not just move) also leaves the source intact", async () => {
    await write("src/IMG_1.dng", "pixels");
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "copy",
      collision: "auto-suffix",
      onVerified: async () => {
        throw new Error("simulated crash");
      },
    });
    expect(outcome.kind).toBe("error");
    expect(await read("src/IMG_1.dng")).toBe("pixels");
    expect(await exists("dst/IMG_1.dng")).toBe(false);
  });

  test("a hard copy failure (missing source) errors cleanly with nothing created", async () => {
    // No file written at src/DOES_NOT_EXIST.dng.
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/DOES_NOT_EXIST.dng"),
      destAbsPath: abs("dst/DOES_NOT_EXIST.dng"),
      mode: "move",
      collision: "auto-suffix",
    });
    expect(outcome.kind).toBe("error");
    expect(await exists("dst/DOES_NOT_EXIST.dng")).toBe(false);
  });

  test("onVerified succeeding commits the delete — no orphan, no duplicate", async () => {
    await write("src/IMG_1.dng", "pixels");
    let hookRan = false;
    const outcome = await relocateFile({
      sourceAbsPath: abs("src/IMG_1.dng"),
      destAbsPath: abs("dst/IMG_1.dng"),
      mode: "move",
      collision: "auto-suffix",
      onVerified: async (info) => {
        expect(info.newAbsPath).toBe(abs("dst/IMG_1.dng"));
        hookRan = true;
      },
    });
    expect(hookRan).toBe(true);
    expect(outcome.kind).toBe("relocated");
    expect(await exists("src/IMG_1.dng")).toBe(false);
    expect(await read("dst/IMG_1.dng")).toBe("pixels");
  });
});

// ---------------------------------------------------------------------------
// pickFreePath / sidecarRenameTarget — small unit tests for the extracted
// helpers now shared with fs/trash.ts (moveSidecarsAlongside).
// ---------------------------------------------------------------------------

describe("pickFreePath", () => {
  test("returns the base path unchanged when free", async () => {
    expect(await pickFreePath(abs("nope/x.dng"))).toBe(abs("nope/x.dng"));
  });

  test("suffixes with .N on collision, skipping occupied candidates", async () => {
    await write("d/x.dng", "a");
    await write("d/x.1.dng", "b");
    expect(await pickFreePath(abs("d/x.dng"))).toBe(abs("d/x.2.dng"));
  });
});

describe("sidecarRenameTarget", () => {
  test("applies the same base-swap as the primary rename", () => {
    const result = sidecarRenameTarget(
      abs("src/IMG_1.dng"),
      abs("dst/IMG_1.1.dng"),
      abs("src/IMG_1.xmp"),
    );
    expect(result).toBe(abs("dst/IMG_1.1.xmp"));
  });

  test("returns null (defensive) when the sidecar name does not start with the old base", () => {
    const result = sidecarRenameTarget(
      abs("src/IMG_1.dng"),
      abs("dst/IMG_1.dng"),
      abs("src/IMG_2 (conflict from Mac).xmp"),
    );
    expect(result).toBeNull();
  });
});
