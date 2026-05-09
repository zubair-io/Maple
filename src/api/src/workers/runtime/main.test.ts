import { describe, expect, it } from "bun:test";
import { loadStage } from "./main.ts";

describe("loadStage", () => {
  it("throws for unknown stage names", async () => {
    await expect(loadStage("__nonexistent_stage__")).rejects.toThrow();
  });
});
