import { AUTO_FIT_OUTCOMES, type AutoFitOutcome } from '../generated/auto-fit-outcome.generated';

/** Actual Auto outcome of a completed render (#5458); absent with Neutral or before evaluation. */
export type { AutoFitOutcome };

/** An unrecognised wire value still means Auto ran without a usable fit. */
export function autoFitOutcomeFrom(wire: string | null | undefined): AutoFitOutcome | undefined {
  if (wire == null) return undefined;
  return AUTO_FIT_OUTCOMES.find((outcome) => outcome === wire) ?? 'unfitted';
}
