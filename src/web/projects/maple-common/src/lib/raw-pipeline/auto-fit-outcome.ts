/** Actual Auto outcome of a completed render (#5458); absent with Neutral or before evaluation. */
export type AutoFitOutcome = 'applied' | 'no-preview' | 'unfitted';

/** An unrecognised wire value still means Auto ran without a usable fit. */
export function autoFitOutcomeFrom(wire: string | null | undefined): AutoFitOutcome | undefined {
  if (wire == null) return undefined;
  return wire === 'applied' || wire === 'no-preview' ? wire : 'unfitted';
}
