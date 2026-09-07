// editor-shell-hud.ts — scrub HUD label formatting.
//
// Extracted from `editor-shell.component.ts` to stay under the per-file LOC
// budget, alongside the sibling `editor-shell-{chrome,keyboard,route,scrub}`
// modules. These three are the pure half of the HUD: given the armed tool and
// its current value they produce the strings and the 0–1 bar fraction the
// overlay renders, plus the fade timer that owns when the overlay is up —
// the same `newXState()` + free-functions shape `editor-shell-{chrome,scrub,
// undo}.ts` use, so the component holds one opaque handle instead of a raw
// `setTimeout` id and its three lifecycle branches.

import {
  type ToolGroup,
  type ToolId,
  TOOL_GROUP_DISPLAY,
  TOOL_DISPLAY,
} from '../../editor/tool-model';
import { toolMetadata } from '../../editor/tool-metadata';

/** `"Color · Saturation"` — the small caption above the HUD value. */
export function hudEyebrowText(group: ToolGroup, tool: ToolId): string {
  return `${TOOL_GROUP_DISPLAY[group]} · ${TOOL_DISPLAY[tool]}`;
}

/**
 * The HUD's big value string. Readout decimals come from the generated
 * metadata (`tool-metadata.ts`, #2448) — the EV range is fine-grained enough
 * to want two decimals, the rest read as whole numbers — so the HUD and the
 * control card's step can't disagree. Positive values carry an explicit `+`
 * so a slider at `+15` never looks like it might be `-15`.
 */
export function hudValueLabel(value: number, tool: ToolId): string {
  const meta = toolMetadata(tool);
  if (!meta) return String(Math.round(value));
  const formatted = value.toFixed(meta.decimals);
  return value > 0 ? `+${formatted}` : formatted;
}

/** Map the internal `[-100, +100]` value onto the HUD bar's `[0, 1]`. */
export function hudProgressFraction(internalValue: number): number {
  return (internalValue + 100) / 200;
}

// ── Fade timer ──────────────────────────────────────────────────────────

/** How long the HUD stays up after the last scrub sample, in ms. */
const HUD_FADE_DELAY_MS = 600;

/** The component-owned surface these functions drive. */
interface HudHost {
  readonly hudVisible: { set(value: boolean): void };
}

/** Opaque fade-timer handle, held by the component. */
export interface HudFadeState {
  timer: ReturnType<typeof setTimeout> | null;
}

export function newHudFadeState(): HudFadeState {
  return { timer: null };
}

/** Cancel a pending fade — safe to call when none is scheduled. */
export function hudClearTimer(state: HudFadeState): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/** Show the HUD now and cancel any pending fade. */
export function hudShow(host: HudHost, state: HudFadeState): void {
  hudClearTimer(state);
  host.hudVisible.set(true);
}

/** Hide the HUD after `HUD_FADE_DELAY_MS`, restarting the countdown. */
export function hudScheduleFade(host: HudHost, state: HudFadeState): void {
  hudClearTimer(state);
  state.timer = setTimeout(() => host.hudVisible.set(false), HUD_FADE_DELAY_MS);
}
