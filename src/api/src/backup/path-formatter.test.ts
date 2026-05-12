import { describe, test, expect } from "bun:test";
import { formatBackupPath } from "./path-formatter.ts";

const capture = new Date("2024-03-15T10:30:00Z");

describe("formatBackupPath", () => {
  test("with location → year/location/MM-DD/filename", () => {
    expect(formatBackupPath({
      captureDate: capture,
      location: "Tokyo",
      filename: "IMG_0420.HEIC",
    })).toBe("2024/Tokyo/03-15/IMG_0420.HEIC");
  });

  test("no location → year/MM/DD/filename", () => {
    expect(formatBackupPath({
      captureDate: capture,
      location: null,
      filename: "IMG_0420.HEIC",
    })).toBe("2024/03/15/IMG_0420.HEIC");
  });

  test("strips path-unsafe chars from location", () => {
    expect(formatBackupPath({
      captureDate: capture,
      location: "St. Tropez / Var",
      filename: "IMG.heic",
    })).toBe("2024/St. Tropez _ Var/03-15/IMG.heic");
  });

  test("empty location string treated as null", () => {
    expect(formatBackupPath({
      captureDate: capture,
      location: "",
      filename: "IMG.heic",
    })).toBe("2024/03/15/IMG.heic");
  });
});
