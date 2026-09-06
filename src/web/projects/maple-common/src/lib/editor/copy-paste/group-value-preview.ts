import type { AdjustmentModel } from '../../models/adjustment-model';
import { ADJUSTMENT_GROUPS, buildGroupPatch, type AdjustmentGroupId } from './adjustment-groups';

export interface GroupValueChange {
  readonly field: string;
  readonly before: string;
  readonly after: string;
  readonly changedCount: number;
}

function displayValue(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'string') return value || 'None';
  if (typeof value === 'object' && value !== null && 'top' in value) {
    const crop = value as AdjustmentModel['crop'];
    return `${displayValue(crop.top * 100)}%, ${displayValue(crop.left * 100)}% – ${displayValue(crop.bottom * 100)}%, ${displayValue(crop.right * 100)}%; ${displayValue(crop.angle)}°`;
  }
  return JSON.stringify(value) ?? 'Unset';
}

/** Compare the actual patch, including clamping/omissions, against every destination. */
export function groupValuePreview(
  source: AdjustmentModel,
  targets: readonly AdjustmentModel[],
): Readonly<Record<AdjustmentGroupId, readonly GroupValueChange[]>> {
  const result: Record<AdjustmentGroupId, readonly GroupValueChange[]> = {
    white_balance: [],
    tone: [],
    color: [],
    detail: [],
    effects: [],
    geometry: [],
  };
  for (const group of ADJUSTMENT_GROUPS) {
    const patch = buildGroupPatch(source, [group.id]);
    const changes = Object.entries(patch).flatMap(([field, after]) => {
      const key = field as keyof AdjustmentModel;
      // As Shot numbers are display seeds, not authored settings.
      if ((key === 'temperature' || key === 'tint') && source.whiteBalancePreset === 'As Shot')
        return [];
      const values = targets.map((target) => target[key]);
      const changedCount = values.filter(
        (before) => JSON.stringify(before) !== JSON.stringify(after),
      ).length;
      if (changedCount === 0) return [];
      const distinct = [...new Set(values.map(displayValue))];
      return [
        {
          field: field.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
          before:
            distinct.length === 1
              ? distinct[0]
              : `Mixed: ${distinct.slice(0, 3).join(', ')}${distinct.length > 3 ? ` (+${distinct.length - 3} more)` : ''}`,
          after: displayValue(after),
          changedCount,
        },
      ];
    });
    result[group.id] = changes;
  }
  return result;
}
