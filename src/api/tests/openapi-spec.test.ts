/**
 * Integration test for the OpenAPI spec endpoint (issue #131).
 *
 * Asserts that /openapi.json is served, parses as JSON, carries the
 * Maple API title, and lists at least one mounted path. This is the
 * source-of-truth document that web + apple clients will codegen from.
 */
import { describe, test, expect } from "bun:test";
import { buildApp } from "../src/index.ts";

describe("GET /openapi.json", () => {
  test("returns a parseable OpenAPI document with the Maple API title and at least one path", async () => {
    const app = buildApp();

    const res = await app.handle(
      new Request("http://localhost/openapi.json", { method: "GET" }),
    );

    expect(res.status).toBe(200);

    const text = await res.text();
    let doc: {
      info?: { title?: string; version?: string };
      paths?: Record<string, unknown>;
    };
    expect(() => {
      doc = JSON.parse(text);
    }).not.toThrow();
    doc = JSON.parse(text);

    expect(doc.info?.title).toBe("Maple API");
    expect(typeof doc.info?.version).toBe("string");

    expect(doc.paths).toBeDefined();
    const pathKeys = Object.keys(doc.paths ?? {});
    expect(pathKeys.length).toBeGreaterThan(0);

    // /api/health is the canonical no-auth GET — it should always appear.
    expect(pathKeys).toContain("/api/health");
  });
});
