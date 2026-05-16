import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { moveToTrash, moveOutOfTrash, computeTrashPath } from "../src/fs/trash.ts";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-trash-move-"));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("moveToTrash", () => {
  test("moves RAW + sidecars into .maple/trash/<rel>, preserving relative path", async () => {
    const dir = path.join(tmpRoot, "2024", "01-15");
    await fs.mkdir(dir, { recursive: true });
    const raw = path.join(dir, "IMG_1.ARW");
    const xmp = path.join(dir, "IMG_1.xmp");
    const conflict = path.join(dir, "IMG_1 (conflict from Mac).xmp");
    await fs.writeFile(raw, "raw");
    await fs.writeFile(xmp, "canon");
    await fs.writeFile(conflict, "conflict");

    const result = await moveToTrash(raw, tmpRoot);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.newAbsPath).toBe(path.join(tmpRoot, ".maple", "trash", "2024", "01-15", "IMG_1.ARW"));

    // RAW + sidecars gone from original.
    await expect(fs.stat(raw)).rejects.toThrow();
    await expect(fs.stat(xmp)).rejects.toThrow();
    await expect(fs.stat(conflict)).rejects.toThrow();

    // RAW + sidecars present in trash.
    await fs.stat(result.newAbsPath);
    await fs.stat(path.join(tmpRoot, ".maple", "trash", "2024", "01-15", "IMG_1.xmp"));
    await fs.stat(path.join(tmpRoot, ".maple", "trash", "2024", "01-15", "IMG_1 (conflict from Mac).xmp"));
  });

  test("appends .N when the trash target already exists", async () => {
    const dir = path.join(tmpRoot, "redelete");
    await fs.mkdir(dir, { recursive: true });
    const raw1 = path.join(dir, "IMG_2.ARW");
    await fs.writeFile(raw1, "first");
    const first = await moveToTrash(raw1, tmpRoot);
    expect(first.kind).toBe("ok");

    // Same name, same relative path — second trash must not clobber first.
    await fs.writeFile(raw1, "second");
    const second = await moveToTrash(raw1, tmpRoot);
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.newAbsPath).toBe(path.join(tmpRoot, ".maple", "trash", "redelete", "IMG_2.1.ARW"));

    // First file still there, second next to it with .1 suffix.
    expect(await fs.readFile(path.join(tmpRoot, ".maple", "trash", "redelete", "IMG_2.ARW"), "utf-8")).toBe("first");
    expect(await fs.readFile(path.join(tmpRoot, ".maple", "trash", "redelete", "IMG_2.1.ARW"), "utf-8")).toBe("second");
  });
});

describe("moveOutOfTrash", () => {
  test("moves RAW + sidecars back to target, appends .restored on collision", async () => {
    const dir = path.join(tmpRoot, "restore");
    await fs.mkdir(dir, { recursive: true });
    const raw = path.join(dir, "IMG_3.ARW");
    await fs.writeFile(raw, "raw");
    await fs.writeFile(path.join(dir, "IMG_3.xmp"), "x");
    const trashed = await moveToTrash(raw, tmpRoot);
    expect(trashed.kind).toBe("ok");
    if (trashed.kind !== "ok") return;

    // Make the original location collide.
    await fs.writeFile(raw, "newer");

    const result = await moveOutOfTrash(trashed.newAbsPath, raw);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.newAbsPath).toBe(path.join(dir, "IMG_3.restored.ARW"));

    // Both files present at the same level.
    expect(await fs.readFile(raw, "utf-8")).toBe("newer");
    expect(await fs.readFile(path.join(dir, "IMG_3.restored.ARW"), "utf-8")).toBe("raw");
    // Sidecar followed with `.restored` to match new RAW base.
    await fs.stat(path.join(dir, "IMG_3.restored.xmp"));
  });
});

describe("computeTrashPath", () => {
  test("places file under .maple/trash/<rel-to-root>", () => {
    expect(
      computeTrashPath("/library/2024/IMG_1.ARW", "/library"),
    ).toBe("/library/.maple/trash/2024/IMG_1.ARW");
  });

  test("throws when abs path is not under the root", () => {
    expect(() => computeTrashPath("/other/IMG_1.ARW", "/library")).toThrow();
  });
});
