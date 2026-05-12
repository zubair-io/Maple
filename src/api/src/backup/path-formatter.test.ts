import { describe, test, expect } from "bun:test";
import { formatBackupPath, isSafeFilename } from "./path-formatter.ts";

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

describe("isSafeFilename", () => {
  test("empty string → false", () => expect(isSafeFilename("")).toBe(false));
  test("name over 255 chars → false", () => expect(isSafeFilename("a".repeat(256))).toBe(false));
  test("name with forward slash → false", () => expect(isSafeFilename("foo/bar.jpg")).toBe(false));
  test("name with backslash → false", () => expect(isSafeFilename("foo\\bar.jpg")).toBe(false));
  test("'.' → false", () => expect(isSafeFilename(".")).toBe(false));
  test("'..' → false", () => expect(isSafeFilename("..")).toBe(false));
  test("leading dot → false", () => expect(isSafeFilename(".hidden")).toBe(false));
  test("normal filename → true", () => expect(isSafeFilename("IMG_0420.HEIC")).toBe(true));
  test("exactly 255 chars → true", () => expect(isSafeFilename("a".repeat(255))).toBe(true));
});

describe("formatBackupPath — filename safety", () => {
  test("'../etc/passwd' filename → throws", () => {
    expect(() => formatBackupPath({ captureDate: capture, location: null, filename: "../etc/passwd" })).toThrow("unsafe filename");
  });

  test("'foo/bar.jpg' filename → throws", () => {
    expect(() => formatBackupPath({ captureDate: capture, location: null, filename: "foo/bar.jpg" })).toThrow("unsafe filename");
  });

  test("'.hidden' filename → throws", () => {
    expect(() => formatBackupPath({ captureDate: capture, location: null, filename: ".hidden" })).toThrow("unsafe filename");
  });

  test("empty filename → throws", () => {
    expect(() => formatBackupPath({ captureDate: capture, location: null, filename: "" })).toThrow("unsafe filename");
  });

  test("256-char filename → throws", () => {
    expect(() => formatBackupPath({ captureDate: capture, location: null, filename: "a".repeat(256) })).toThrow("unsafe filename");
  });

  test("'..' location → fallback to no-GPS shape", () => {
    // location ".." after slash-replacement is ".." — treated as null
    expect(formatBackupPath({ captureDate: capture, location: "..", filename: "IMG.heic" }))
      .toBe("2024/03/15/IMG.heic");
  });
});
