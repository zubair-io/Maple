import { describe, it, expect } from "bun:test";

describe("workerConfigCollection import", () => {
  it("exports workerConfigCollection from db/client", async () => {
    const mod = await import("../db/client.ts");
    expect(typeof mod.workerConfigCollection).toBe("function");
  });
});
