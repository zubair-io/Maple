import { describe, expect, it } from "bun:test";
import {
  DEFAULT_GPU_LIVE_RENDER_ENABLED,
  resolveRenderConfig,
  type RenderConfig,
} from "./render-config.repo.ts";

describe("resolveRenderConfig", () => {
  it("defaults GPU live render ON when no row has been written", () => {
    // The fallback is the whole safety story for this setting: a fresh
    // database, or one this API cannot reach, must behave exactly like the
    // pre-#1062 build-time token (default true).
    const resolved = resolveRenderConfig(null);
    expect(resolved.gpu_live_render_enabled).toBe(
      DEFAULT_GPU_LIVE_RENDER_ENABLED,
    );
    expect(resolved.gpu_live_render_enabled).toBe(true);
    expect(resolved.source.gpu_live_render_enabled).toBe("default");
  });

  it("defaults ON when the row exists but the field was never set", () => {
    const resolved = resolveRenderConfig({
      updated_at: 1,
    } satisfies RenderConfig);
    expect(resolved.gpu_live_render_enabled).toBe(true);
    expect(resolved.source.gpu_live_render_enabled).toBe("default");
  });

  it("honours a saved false (the operator kill switch)", () => {
    const resolved = resolveRenderConfig({ gpu_live_render_enabled: false });
    expect(resolved.gpu_live_render_enabled).toBe(false);
    expect(resolved.source.gpu_live_render_enabled).toBe("db");
  });

  it("honours a saved true and reports it as db-sourced", () => {
    const resolved = resolveRenderConfig({ gpu_live_render_enabled: true });
    expect(resolved.gpu_live_render_enabled).toBe(true);
    expect(resolved.source.gpu_live_render_enabled).toBe("db");
  });

  it("treats an explicit null as cleared back to the default", () => {
    const resolved = resolveRenderConfig({ gpu_live_render_enabled: null });
    expect(resolved.gpu_live_render_enabled).toBe(true);
    expect(resolved.source.gpu_live_render_enabled).toBe("default");
  });

  it("falls back to the default for a hand-edited non-boolean row", () => {
    // A row edited straight in Mongo could hold anything. Degrading to the
    // default keeps the editor rendering rather than failing closed on a typo.
    const resolved = resolveRenderConfig({
      gpu_live_render_enabled: "false" as unknown as boolean,
    });
    expect(resolved.gpu_live_render_enabled).toBe(true);
    expect(resolved.source.gpu_live_render_enabled).toBe("default");
  });
});
