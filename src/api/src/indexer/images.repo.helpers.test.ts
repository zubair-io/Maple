import { describe, test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  assetAbsPath,
  assetLibraryPath,
  assetPrimaryFileInfo,
} from "./images.repo.ts";
import type { AssetDoc, FileInfo } from "../db/schema.ts";

const libId = new ObjectId();

function makeAsset(over: Partial<AssetDoc>): AssetDoc {
  return {
    folder_id: libId,
    filename: "IMG_001.dng",
    abs_path: "/lib/vacation/2024/IMG_001.dng",
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: "2026-05-20T00:00:00Z",
    ...over,
  };
}

describe("assetPrimaryFileInfo", () => {
  test("returns the first live entry", () => {
    const fi: FileInfo = {
      path: "vacation/2024",
      filename: "IMG_001.dng",
      library_id: libId,
    };
    expect(assetPrimaryFileInfo(makeAsset({ fileinfo: [fi] }))).toEqual(fi);
  });

  test("skips entries marked deleted", () => {
    const dead: FileInfo = {
      path: "old",
      filename: "x.dng",
      library_id: libId,
      deleted_at: "2026-05-20T00:00:00Z",
    };
    const live: FileInfo = {
      path: "new",
      filename: "x.dng",
      library_id: libId,
    };
    expect(
      assetPrimaryFileInfo(makeAsset({ fileinfo: [dead, live] })),
    ).toEqual(live);
  });

  test("returns null when fileinfo is missing", () => {
    expect(assetPrimaryFileInfo(makeAsset({}))).toBeNull();
  });

  test("returns null when every entry is dead", () => {
    const dead: FileInfo = {
      path: "x",
      filename: "y.dng",
      library_id: libId,
      deleted_at: "now",
    };
    expect(assetPrimaryFileInfo(makeAsset({ fileinfo: [dead] }))).toBeNull();
  });
});

describe("assetAbsPath", () => {
  test("composes from library root + primary fileinfo", () => {
    const fi: FileInfo = {
      path: "vacation/2024",
      filename: "IMG_001.dng",
      library_id: libId,
    };
    const libraries = new Map([[libId.toHexString(), "/lib"]]);
    expect(assetAbsPath(makeAsset({ fileinfo: [fi] }), libraries)).toBe(
      "/lib/vacation/2024/IMG_001.dng",
    );
  });

  test("falls back to legacy abs_path when fileinfo absent", () => {
    const libraries = new Map<string, string>();
    expect(assetAbsPath(makeAsset({}), libraries)).toBe(
      "/lib/vacation/2024/IMG_001.dng",
    );
  });

  test("falls back to legacy abs_path when library_id is unknown", () => {
    const fi: FileInfo = {
      path: "x",
      filename: "y.dng",
      library_id: new ObjectId(),
    };
    const libraries = new Map<string, string>();
    expect(assetAbsPath(makeAsset({ fileinfo: [fi] }), libraries)).toBe(
      "/lib/vacation/2024/IMG_001.dng",
    );
  });

  test("handles path='' (file at library root)", () => {
    const fi: FileInfo = {
      path: "",
      filename: "root.dng",
      library_id: libId,
    };
    const libraries = new Map([[libId.toHexString(), "/lib"]]);
    const asset = makeAsset({
      fileinfo: [fi],
      abs_path: "/lib/root.dng",
      filename: "root.dng",
    });
    expect(assetAbsPath(asset, libraries)).toBe("/lib/root.dng");
  });

  test("returns null when neither fileinfo nor abs_path can resolve", () => {
    const libraries = new Map<string, string>();
    expect(assetAbsPath({ fileinfo: undefined, abs_path: "" }, libraries)).toBeNull();
  });
});

describe("assetLibraryPath", () => {
  test("resolves library root from fileinfo[0].library_id", () => {
    const fi: FileInfo = {
      path: "x",
      filename: "y.dng",
      library_id: libId,
    };
    const libraries = new Map([[libId.toHexString(), "/srv/lib"]]);
    expect(assetLibraryPath(makeAsset({ fileinfo: [fi] }), libraries)).toBe(
      "/srv/lib",
    );
  });

  test("falls back to dirname(abs_path) for legacy rows", () => {
    const libraries = new Map<string, string>();
    expect(assetLibraryPath(makeAsset({}), libraries)).toBe(
      "/lib/vacation/2024",
    );
  });
});
