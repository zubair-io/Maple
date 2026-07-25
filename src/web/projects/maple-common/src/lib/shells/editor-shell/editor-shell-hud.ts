// editor-shell-hud.ts — scrub HUD label formatting.
//
// Extracted from `editor-shell.component.ts` to stay under the per-file LOC
// budget, alongside the sibling `editor-shell-{chrome,keyboard,route,scrub}`
// modules. These three are the pure half of the HUD: given the armed tool and
// its current value they produce the strings and the 0–1 bar fraction the
// overlay renders. The timer / visibility half stays on the component, since
// it owns the signal and the fade handle.

import {
  type ToolGroup,
  type ToolId,
  TOOL_GROUP_DISPLAY,
  TOOL_DISPLAY,
  displayRange,
} from '../../editor/tool-model';

/** `"Color · Saturation"` — the small caption above the HUD value. */
export function hudEyebrowText(group: ToolGroup, tool: ToolId): string {
  return `${TOOL_GROUP_DISPLAY[group]} · ${TOOL_DISPLAY[tool]}`;
}

/**
 * The HUD's big value string. Tools whose display range tops out at 4 or less
 * (exposure, in stops) are fine-grained enough to want two decimals; the rest
 * read as whole numbers. Positive values carry an explicit `+` so a slider at
 * `+15` never looks like it might be `-15`.
 */
export function hudValueLabel(value: number, tool: ToolId): string {
  const range = displayRange(tool);
  if (!range) return String(Math.round(value));
  const step = range[1] <= 4 ? 0.01 : 1;
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const formatted = value.toFixed(decimals);
  return value > 0 ? `+${formatted}` : formatted;
}

/** Map the internal `[-100, +100]` value onto the HUD bar's `[0, 1]`. */
export function hudProgressFraction(internalValue: number): number {
  return (internalValue + 100) / 200;
}
