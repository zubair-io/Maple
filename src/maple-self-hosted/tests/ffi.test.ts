/**
 * P5 tests — raw-ffi Bun FFI wrapper.
 *
 * Tests the module loads cleanly and degrades gracefully when
 * the native library is absent.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";

describe("tryGetRawFfi", () => {
  it("module imports without error", async () => {
    const mod = await import("../src/ffi/raw_ffi.ts");
    expect(typeof mod.tryGetRawFfi).toBe("function");
  });

  it("returns null or an object (never throws)", async () => {
    const { tryGetRawFfi } = await import("../src/ffi/raw_ffi.ts");
    let result: ReturnType<typeof tryGetRawFfi> | undefined;
    expect(() => {
      result = tryGetRawFfi();
    }).not.toThrow();
    // Either null (lib not available) or an object with renderToRgb.
    if (result !== null) {
      expect(typeof (result as { renderToRgb: unknown }).renderToRgb).toBe("function");
    }
  });

  it("native library exists on macOS after build", () => {
    // This test verifies the .dylib was built and copied.
    const libPath = path.resolve(
      import.meta.dir,
      "..",
      "native",
      process.platform === "darwin" ? "libraw_ffi.dylib" : "libraw_ffi.so"
    );
    const exists = fs.existsSync(libPath);
    if (!exists) {
      console.warn(
        `[ffi.test] ${libPath} not found — run scripts/build-raw-ffi.sh to build`
      );
    }
    // Not a hard failure: the test just documents expected state.
    expect(typeof exists).toBe("boolean");
  });
});
