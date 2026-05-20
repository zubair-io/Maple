import { describe, expect, it } from "bun:test";
import { emptyXmp, xmlAttrEscape } from "./xmp.ts";

/**
 * `emptyXmp(filename)` interpolates `filename` into `rdf:Description
 * rdf:about="…"`. Bug #168: prior to this fix the filename was
 * interpolated raw, so a name containing `"` closed the attribute early
 * and a name containing `<` could inject XML.
 *
 * Bun does not ship a DOM/XML parser, so we verify well-formedness by:
 *   1. extracting the `rdf:about` attribute value via regex,
 *   2. unescaping the five XML entities, and
 *   3. confirming the result equals the original filename.
 *
 * Plus: assert that no raw `<` `>` `&` `"` `'` survives inside the
 * attribute value in the rendered output.
 */

function xmlAttrUnescape(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function extractRdfAbout(xmp: string): string {
  // `rdf:about="…"` — value is delimited by the next unescaped `"`. We
  // escape `"` in the producer, so the closing quote is always literal.
  const m = xmp.match(/rdf:about="([^"]*)"/);
  if (!m) throw new Error("rdf:about not found");
  return m[1];
}

describe("xmlAttrEscape", () => {
  it("maps the five XML predefined entities", () => {
    expect(xmlAttrEscape(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &apos;");
  });

  it("escapes ampersand before other entities (no double-escape)", () => {
    // `<` would become `&lt;` — if `&` is escaped LAST, we'd get
    // `&amp;lt;`. Confirm we get `&amp;` + `&lt;` in the right order.
    expect(xmlAttrEscape("<&>")).toBe("&lt;&amp;&gt;");
  });

  it("is a no-op for plain text", () => {
    expect(xmlAttrEscape("plain.dng")).toBe("plain.dng");
  });

  it("passes non-ASCII through untouched", () => {
    expect(xmlAttrEscape("日本語.dng")).toBe("日本語.dng");
  });
});

describe("emptyXmp", () => {
  it("produces well-formed XML for a plain filename", () => {
    const xmp = emptyXmp("plain.dng");
    expect(xmp).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(extractRdfAbout(xmp)).toBe("plain.dng");
  });

  it("survives adversarial filenames containing each XML special character", () => {
    const cases = [
      `a"b.dng`,
      `a&b.dng`,
      `a<b.dng`,
      `a>b.dng`,
      `a'b.dng`,
      // The "close the attribute and inject an element" payload from #168.
      `evil" foo="bar`,
      // Pure-injection attempt.
      `"><script/>`,
      // & ampersand chaining.
      `a&amp;b&lt;c`,
    ];
    for (const filename of cases) {
      const xmp = emptyXmp(filename);
      const aboutValue = extractRdfAbout(xmp);
      expect(xmlAttrUnescape(aboutValue)).toBe(filename);
      // No raw special characters survive inside the attribute value.
      expect(aboutValue).not.toContain('"');
      expect(aboutValue).not.toContain("<");
      expect(aboutValue).not.toContain(">");
      expect(aboutValue).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
    }
  });

  it("does not allow the filename to close rdf:Description early", () => {
    const xmp = emptyXmp(`evil"/>`);
    // Exactly one `<rdf:Description …/>` self-closing element should remain.
    const opens = xmp.match(/<rdf:Description\b/g) ?? [];
    const closes = xmp.match(/\/>/g) ?? [];
    expect(opens).toHaveLength(1);
    // The injected `/>` becomes `&quot;/&gt;` inside the attribute, so the
    // only `/>` token in the document is the legitimate self-close of
    // rdf:Description.
    expect(closes).toHaveLength(1);
  });

  it("preserves non-ASCII filenames verbatim (XML allows UTF-8 in attributes)", () => {
    const xmp = emptyXmp("日本語.dng");
    expect(extractRdfAbout(xmp)).toBe("日本語.dng");
  });
});
