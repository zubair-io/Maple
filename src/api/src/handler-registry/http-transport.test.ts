/**
 * HTTP transport — unit tests with a stubbed fetch.
 *
 * Verifies the contract round-trip, retry-once-on-5xx, no-retry-on-4xx,
 * timeout surfacing, and schema validation on the response.
 */

import { describe, it, expect } from "bun:test";
import { dispatchAi, type FetchLike } from "./http-transport.ts";
import type { AiHandlerInput } from "./contract.ts";
import { CONTRACT_VERSION } from "./contract.ts";

function makeInput(overrides: Partial<AiHandlerInput> = {}): AiHandlerInput {
  return {
    contractVersion: CONTRACT_VERSION,
    stage: "ai",
    mapleId: "01abcdef",
    absPath: "/tmp/x.dng",
    exif: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("http-transport: dispatchAi", () => {
  it("round-trips a successful call and returns parsed faces/aiTags", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      return jsonResponse(200, {
        contractVersion: CONTRACT_VERSION,
        faces: [{ bbox: { x: 0, y: 0, w: 0.5, h: 0.5 }, personId: null, confidence: 0.9 }],
        aiTags: ["dog", "outdoor"],
      });
    };

    const out = await dispatchAi(makeInput(), {
      url: "https://example.invalid/handler",
      fetchImpl: fakeFetch,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://example.invalid/handler");
    const parsedBody = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(parsedBody.contractVersion).toBe(CONTRACT_VERSION);
    expect(parsedBody.stage).toBe("ai");
    expect(out.faces.length).toBe(1);
    expect(out.aiTags).toEqual(["dog", "outdoor"]);
  });

  it("retries once on 5xx, then surfaces error if still 5xx", async () => {
    let count = 0;
    const fakeFetch: FetchLike = async () => {
      count++;
      return jsonResponse(503, { error: "down" });
    };

    await expect(
      dispatchAi(makeInput(), { url: "https://x.invalid", fetchImpl: fakeFetch })
    ).rejects.toThrow(/HTTP 503/);
    // Initial attempt + one retry.
    expect(count).toBe(2);
  });

  it("retries once on 5xx then succeeds on second attempt", async () => {
    let count = 0;
    const fakeFetch: FetchLike = async () => {
      count++;
      if (count === 1) return jsonResponse(500, { error: "transient" });
      return jsonResponse(200, {
        contractVersion: CONTRACT_VERSION,
        faces: [],
        aiTags: ["recovered"],
      });
    };

    const out = await dispatchAi(makeInput(), {
      url: "https://x.invalid",
      fetchImpl: fakeFetch,
    });
    expect(count).toBe(2);
    expect(out.aiTags).toEqual(["recovered"]);
  });

  it("does NOT retry on 4xx", async () => {
    let count = 0;
    const fakeFetch: FetchLike = async () => {
      count++;
      return jsonResponse(400, { error: "bad request" });
    };

    await expect(
      dispatchAi(makeInput(), { url: "https://x.invalid", fetchImpl: fakeFetch })
    ).rejects.toThrow(/HTTP 400/);
    expect(count).toBe(1);
  });

  it("surfaces timeout/abort as a transport error", async () => {
    const fakeFetch: FetchLike = (_url, init) => {
      // Honour the AbortController. Resolve never; let the caller's timeout fire.
      return new Promise<Response>((_resolve, reject) => {
        if (init.signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };

    await expect(
      dispatchAi(makeInput(), {
        url: "https://x.invalid",
        fetchImpl: fakeFetch,
        timeoutMs: 25,
      })
    ).rejects.toThrow(/transport error/);
  });

  it("rejects responses missing contractVersion", async () => {
    const fakeFetch: FetchLike = async () =>
      jsonResponse(200, { faces: [], aiTags: [] });
    await expect(
      dispatchAi(makeInput(), { url: "https://x.invalid", fetchImpl: fakeFetch })
    ).rejects.toThrow(/contractVersion/);
  });

  it("rejects responses with a non-array faces field", async () => {
    const fakeFetch: FetchLike = async () =>
      jsonResponse(200, { contractVersion: CONTRACT_VERSION, faces: "nope", aiTags: [] });
    await expect(
      dispatchAi(makeInput(), { url: "https://x.invalid", fetchImpl: fakeFetch })
    ).rejects.toThrow(/faces/);
  });
});
