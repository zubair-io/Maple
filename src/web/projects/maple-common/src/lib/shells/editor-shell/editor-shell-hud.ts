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
