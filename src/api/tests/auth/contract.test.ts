// src/api/tests/auth/contract.test.ts
import { describe, it, expect } from "bun:test";
import contract from "../fixtures/auth-contract.json" with { type: "json" };

describe("auth contract", () => {
  it("has 14 endpoints", () => {
    expect(contract.endpoints).toHaveLength(14);
  });

  it("every endpoint has id, method, path", () => {
    for (const e of contract.endpoints) {
      expect(e.id).toBeTruthy();
      expect(e.method).toBeTruthy();
      expect(e.path).toBeTruthy();
    }
  });
});
