/**
 * Smoke tests for the structured logger module. We don't re-validate
 * pino's behaviour here — pino has its own test suite. We just verify
 * the module shape: importing it returns an object that exposes the
 * standard log levels plus a `child()` factory.
 */

import { describe, expect, test } from "bun:test";
import log, { logger, child } from "../src/log.ts";

describe("log module", () => {
  test("default export exposes the pino logging surface", () => {
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.child).toBe("function");
  });

  test("named `logger` export is the same instance as default", () => {
    expect(logger).toBe(log);
  });

  test("`child()` named export returns a logger with the standard methods", () => {
    const c = child("test-component");
    expect(typeof c.info).toBe("function");
    expect(typeof c.warn).toBe("function");
    expect(typeof c.error).toBe("function");
    expect(typeof c.debug).toBe("function");
    expect(typeof c.child).toBe("function");
  });

  test("`logger.child()` (pino's native method) returns a logger", () => {
    const c = logger.child({ component: "via-method" });
    expect(typeof c.info).toBe("function");
    expect(typeof c.warn).toBe("function");
    expect(typeof c.error).toBe("function");
    expect(typeof c.debug).toBe("function");
  });
});
