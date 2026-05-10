import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ObjectId } from "mongodb";
import type { ImageDoc } from "../runtime/define-stage.ts";
import {
  RemoteError,
  type DescribeProvider,
  type DescribeResult,
} from "../../enrichment/describe-providers/index.ts";
import { cachePathFor } from "../../fs/xmp.ts";

import { describeHandler, setDescribeDepsForTests } from "./describe.ts";

function fakeDoc(absPath: string): ImageDoc {
  return {
    _id: new ObjectId(),
    folder_id: new ObjectId(),
    filename: "test.dng",
    abs_path: absPath,
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: new Date().toISOString(),
    exif: {
      captured_at: "2024-06-01T12:00:00.000Z",
      captured_year: 2024,
      captured_month: 6,
      camera_make: null, camera_model: null, lens: null,
      iso: null, aperture: null, shutter: null, focal_length: null, gps: null,
    },
    faces: [],
    description: null,
    place: null,
    stages: {},
  } as ImageDoc;
}

function mockProvider(result: DescribeResult | Error): DescribeProvider {
  return {
    name: "ollama",
    async describe(_bytes, _opts): Promise<DescribeResult> {
      if (result instanceof Error) throw result;
      return result;
    },
    async health(): Promise<void> {},
  };
}

let tmpRoot: string;
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "maple-describe-stage-")); });
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  setDescribeDepsForTests(null);
});

function seedThumb(absPath: string): void {
  const thumbPath = cachePathFor(absPath, "thumbs");
  mkdirSync(dirname(thumbPath), { recursive: true });
  writeFileSync(thumbPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
}

const fakeCtx = {} as never;

describe("describeHandler — happy path", () => {
  it("returns patch with description and description_meta", async () => {
    const absPath = join(tmpRoot, "img.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    const provider = mockProvider({
      text: "A red bicycle against a brick wall.",
      cost_usd: 0.01,
      provider_info: { eval_count: "30" },
    });
    setDescribeDepsForTests({ provider, systemPrompt: "describe this image", model: "llava:latest" });
    const result = await describeHandler(doc, fakeCtx);
    const patch = (result as { patch: Record<string, unknown> }).patch;
    expect(patch.description).toBe("A red bicycle against a brick wall.");
    const meta = patch.description_meta as Record<string, unknown>;
    expect(meta.provider).toBe("ollama");
    expect(meta.model).toBe("llava:latest");
    expect(meta.cost_usd).toBe(0.01);
    expect(meta.eval_count).toBe("30");
    expect(typeof meta.generated_at).toBe("string");
    expect(typeof meta.prompt_version).toBe("number");
  });
});

describe("describeHandler — provider errors", () => {
  it("a retryable RemoteError propagates", async () => {
    const absPath = join(tmpRoot, "img2.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    const provider = mockProvider(new RemoteError("Provider 5xx: 503", true, 503));
    setDescribeDepsForTests({ provider, systemPrompt: "describe this image", model: "llava:latest" });
    await expect(describeHandler(doc, fakeCtx))
      .rejects.toThrow("503");
  });

  it("a non-retryable RemoteError propagates", async () => {
    const absPath = join(tmpRoot, "img3.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    const provider = mockProvider(new RemoteError("Provider 4xx: 401", false, 401));
    setDescribeDepsForTests({ provider, systemPrompt: "describe this image", model: "llava:latest" });
    await expect(describeHandler(doc, fakeCtx))
      .rejects.toThrow("401");
  });
});

describe("describeHandler — provider_info extras stored", () => {
  it("spreads provider_info into description_meta", async () => {
    const absPath = join(tmpRoot, "img4.dng");
    seedThumb(absPath);
    const doc = fakeDoc(absPath);
    const provider = mockProvider({
      text: "two cats",
      cost_usd: 0.04,
      provider_info: { input_tokens: "120", output_tokens: "20" },
    });
    setDescribeDepsForTests({ provider, systemPrompt: "describe this image", model: "llava:latest" });
    const result = await describeHandler(doc, fakeCtx);
    const meta = (result as { patch: { description_meta: Record<string, unknown> } }).patch.description_meta;
    expect(meta.input_tokens).toBe("120");
    expect(meta.output_tokens).toBe("20");
  });
});
