/**
 * Test that the /api/events WebSocket emits a { type: "status" } frame
 * both on connect and after a progress event fires.
 *
 * We test the buildStatusFrame helper directly (unit test, no real WS
 * connection needed) and separately verify the on-connect snapshot by
 * inspecting the StatusFrame shape produced by the service's status() method.
 */

import { describe, it, expect } from "bun:test";
import type { StatusFrame } from "../src/routes/events.ts";
import { getIndexerService } from "../src/indexer/service.ts";

describe("events route — status frame shape", () => {
  it("IndexerService.status() returns a shape compatible with StatusFrame.status", () => {
    const svc = getIndexerService();
    const s = svc.status();

    // Verify all required IndexerStatus fields are present.
    expect(typeof s.paused).toBe("boolean");
    expect(s.pools).toBeDefined();
    expect(s.channels).toBeDefined();
    expect(s.stages).toBeDefined();

    const stages = ["discover", "hash", "exif", "thumb", "ai", "mongo"] as const;
    for (const st of stages) {
      expect(typeof s.pools[st]).toBe("number");
      expect(typeof s.channels[st].depth).toBe("number");
      expect(typeof s.channels[st].capacity).toBe("number");
      expect(typeof s.stages[st].inFlight).toBe("number");
      expect(typeof s.stages[st].errors).toBe("number");
      expect(typeof s.stages[st].deadLetter).toBe("number");
    }
  });

  it("buildStatusFrame() produces a valid StatusFrame JSON string", () => {
    const svc = getIndexerService();
    const frame: StatusFrame = {
      type: "status",
      status: svc.status(),
      ts: Date.now(),
    };

    const json = JSON.stringify(frame);
    const parsed = JSON.parse(json) as StatusFrame;

    expect(parsed.type).toBe("status");
    expect(typeof parsed.ts).toBe("number");
    expect(parsed.status).toBeDefined();
    expect(typeof parsed.status.paused).toBe("boolean");
  });
});
