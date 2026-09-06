import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { groupValuePreview } from './group-value-preview';

describe('group value preview', () => {
  it('shows mixed destinations and counts only photos that change', () => {
    const source = { ...defaultAdjustmentModel(), exposure: 1.25 };
    const targets = [defaultAdjustmentModel(), source, { ...source, exposure: -2 }];
    expect(groupValuePreview(source, targets).tone).toEqual([
      { field: 'Exposure', before: 'Mixed: 0, 1.25, -2', after: '1.25', changedCount: 2 },
    ]);
  });

  it('previews default resets and normalized crop values', () => {
    const source = defaultAdjustmentModel();
    const target = {
      ...source,
      contrast: 42,
      crop: { top: 0.1, left: 0.2, bottom: 0.9, right: 0.8, angle: 3 },
    };
    const preview = groupValuePreview(source, [target]);
    expect(preview.tone[0]).toEqual({
      field: 'Contrast',
      before: '42',
      after: '0',
      changedCount: 1,
    });
    expect(preview.geometry[0].after).toBe('0%, 0% – 100%, 100%; 0°');
    expect(preview.color).toEqual([]);
  });

  it('labels an unopened As Shot target instead of displaying unseeded temperatures', () => {
    const source = {
      ...defaultAdjustmentModel(),
      temperature: 4700,
      tint: 15,
      whiteBalancePreset: 'Custom' as const,
      wbSource: 'Manual' as const,
    };
    const preview = groupValuePreview(source, [defaultAdjustmentModel()]).white_balance;
    expect(preview.find((field) => field.field === 'Temperature')).toMatchObject({
      before: 'As Shot',
      after: '4700',
      changedCount: 1,
    });
    expect(preview.find((field) => field.field === 'Tint')).toMatchObject({
      before: 'As Shot',
      after: '15',
      changedCount: 1,
    });
  });

  it('shows authored WB semantics without presenting As Shot display seeds as edits', () => {
    const source = { ...defaultAdjustmentModel(), temperature: 4700, tint: 15 };
    const target = { ...defaultAdjustmentModel(), temperature: 6200, tint: -2 };
    expect(groupValuePreview(source, [target]).white_balance).toEqual([]);
  });
});
