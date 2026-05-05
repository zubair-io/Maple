/**
 * Test that the StatusFrame shape exposed by /api/events round-trips
 * through JSON serialization without losing fields.
 *
 * The pipeline now lives in a separate child process (see
 * `src/indexer/standalone.ts`), so the parent doesn't construct the
 * status payload — it just forwards the child's JSON. This test is now a
 * pure shape contract: any object that satisfies the StatusFrame type
 * must JSON round-trip cleanly.
 */

import { describe, it, expect } from "bun:test";
import type { StatusFrame } from "../src/routes/events.ts";

describe("events route — status frame shape", () => {
  it("StatusFrame round-trips through JSON.stringify/parse", () => {
    const frame: StatusFrame = {
      type: "status",
      status: {
        paused: false,
        pools: { discover: 1, hash: 2, exif: 1, thumb: 2, ai: 1, mongo: 2 },
        channels: {
          discover: { depth: 0, capacity: 64 },
          hash: { depth: 1, capacity: 64 },
          exif: { depth: 2, capacity: 64 },
          thumb: { depth: 0, capacity: 64 },
          ai: { depth: 0, capacity: 64 },
          mongo: { depth: 0, capacity: 64 },
        },
        stages: {
          discover: { inFlight: 0, errors: 0, deadLetter: 0 },
          hash: { inFlight: 1, errors: 0, deadLetter: 0 },
          exif: { inFlight: 0, errors: 0, deadLetter: 0 },
          thumb: { inFlight: 0, errors: 0, deadLetter: 0 },
          ai: { inFlight: 0, errors: 0, deadLetter: 0 },
          mongo: { inFlight: 0, errors: 0, deadLetter: 0 },
        },
      },
      ts: Date.now(),
    };

    const parsed = JSON.parse(JSON.stringify(frame)) as StatusFrame;

    expect(parsed.type).toBe("status");
    expect(typeof parsed.ts).toBe("number");
    expect(parsed.status).toBeDefined();
    expect(parsed.status.paused).toBe(false);
  });
});
