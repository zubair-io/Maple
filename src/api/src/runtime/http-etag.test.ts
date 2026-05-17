import { describe, expect, it } from "bun:test";
import { computeBodyETag, ifNoneMatchEqual } from "./http-etag.ts";

describe("computeBodyETag", () => {
  it("returns a stable quoted hash for a string body", () => {
    const a = computeBodyETag("hello");
    const b = computeBodyETag("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^"[a-f0-9]+"$/);
  });

  it("differs for different bodies", () => {
    expect(computeBodyETag("a")).not.toBe(computeBodyETag("b"));
  });

  it("accepts a Buffer body", () => {
    const etag = computeBodyETag(Buffer.from([1, 2, 3]));
    expect(etag).toMatch(/^"[a-f0-9]+"$/);
  });
});

describe("ifNoneMatchEqual", () => {
  it("returns true when client matches exactly", () => {
    expect(ifNoneMatchEqual('"abc"', '"abc"')).toBe(true);
  });

  it("tolerates the weak-validator prefix", () => {
    expect(ifNoneMatchEqual('W/"abc"', '"abc"')).toBe(true);
    expect(ifNoneMatchEqual('"abc"', 'W/"abc"')).toBe(true);
  });

  it("returns false when client value differs", () => {
    expect(ifNoneMatchEqual('"abc"', '"def"')).toBe(false);
  });

  it("returns false when client header missing", () => {
    expect(ifNoneMatchEqual(undefined, '"abc"')).toBe(false);
  });

  it("handles wildcard *", () => {
    expect(ifNoneMatchEqual("*", '"abc"')).toBe(true);
  });

  it("handles RFC 9110 comma-separated lists", () => {
    expect(ifNoneMatchEqual('"abc", "def"', '"def"')).toBe(true);
    expect(ifNoneMatchEqual('"abc", "def"', '"xyz"')).toBe(false);
    expect(ifNoneMatchEqual('W/"abc", "def"', '"abc"')).toBe(true);
  });
});
