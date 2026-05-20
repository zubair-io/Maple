import { describe, expect, it } from "bun:test";
import { buildContentDispositionAttachment } from "./http-content-disposition.ts";

/**
 * The Content-Disposition value must:
 *   1. Always start with `attachment;`.
 *   2. Carry a `filename="..."` quoted-string fallback whose value is
 *      pure 7-bit ASCII with `\` and `"` escaped — no CR/LF/NUL leakage.
 *   3. Carry a `filename*=UTF-8''…` form with the original filename
 *      percent-encoded per RFC 5987.
 */

function parseParams(header: string): { disposition: string; params: Record<string, string> } {
  // Naive splitter — fine because we control the producer and only need
  // to verify it. Each segment is `key="quoted"` or `key=token`.
  const parts = header.split(";").map((p) => p.trim());
  const disposition = parts.shift() ?? "";
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { disposition, params };
}

describe("buildContentDispositionAttachment", () => {
  it("emits attachment + both filename and filename* (RFC 6266)", () => {
    const h = buildContentDispositionAttachment("plain.dng");
    const { disposition, params } = parseParams(h);
    expect(disposition).toBe("attachment");
    expect(params.filename).toBe("plain.dng");
    expect(params["filename*"]).toBe("UTF-8''plain.dng");
  });

  it("escapes embedded double-quote in the quoted-string fallback", () => {
    const h = buildContentDispositionAttachment(`weird".dng`);
    const { params } = parseParams(h);
    // Parser strips the wrapping quotes but the inner `\` `"` survives
    // as raw text. The header itself must contain the escape sequence.
    expect(h).toContain(`filename="weird\\".dng"`);
    expect(params["filename*"]).toBe("UTF-8''weird%22.dng");
  });

  it("escapes backslash in the quoted-string fallback", () => {
    const h = buildContentDispositionAttachment(`a\\b.dng`);
    expect(h).toContain(`filename="a\\\\b.dng"`);
    expect(h).toContain("filename*=UTF-8''a%5Cb.dng");
  });

  it("strips CR/LF/NUL — no response-splitting", () => {
    const h = buildContentDispositionAttachment("evil\r\nX-Injected: 1\0.dng");
    // The header value itself must not contain raw CR/LF/NUL — those are
    // what would terminate the header / inject a new one in a naïve
    // serialiser. The visible follow-on text (`X-Injected: 1`) is harmless
    // once the CRLF separator is gone, so we only assert the bytes that
    // matter.
    expect(h).not.toContain("\r");
    expect(h).not.toContain("\n");
    expect(h).not.toContain("\0");
    // Visible non-control bytes survive inside the quoted-string (still
    // 7-bit ASCII, still safe).
    expect(h).toContain(`filename="evilX-Injected: 1.dng"`);
    // UTF-8 form percent-encodes the control bytes.
    expect(h).toContain("filename*=UTF-8''evil%0D%0AX-Injected%3A%201%00.dng");
  });

  it("folds non-ASCII in the quoted-string fallback but preserves it in filename*", () => {
    const h = buildContentDispositionAttachment("日本語.dng");
    expect(h).toContain(`filename="___.dng"`);
    // %E6%97%A5 = 日, %E6%9C%AC = 本, %E8%AA%9E = 語
    expect(h).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.dng");
  });

  it("encodes the RFC 5987 attr-char extras that encodeURIComponent leaves alone", () => {
    const h = buildContentDispositionAttachment("a'b(c)*d!e~f.dng");
    expect(h).toContain(
      "filename*=UTF-8''a%27b%28c%29%2Ad%21e%7Ef.dng",
    );
  });

  it("falls back to `download` when ASCII reduction leaves the string empty", () => {
    const h = buildContentDispositionAttachment("日本語");
    // Above test already verified non-ASCII → `_` ; here we just sanity-
    // check a corner case where the original is purely whitespace.
    const h2 = buildContentDispositionAttachment("   ");
    expect(h2).toContain(`filename="download"`);
    expect(h).toContain(`filename="___"`);
  });

  it("orders filename before filename* (legacy-client preference)", () => {
    const h = buildContentDispositionAttachment("a.dng");
    expect(h.indexOf("filename=")).toBeLessThan(h.indexOf("filename*="));
  });

  it("uses semicolons (not commas) as parameter separators (RFC 6266)", () => {
    const h = buildContentDispositionAttachment("a.dng");
    expect(h).not.toContain(",");
    expect(h.split(";")).toHaveLength(3);
  });
});
