import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { coldOpenRenderedModel } from './image-canvas.cold-open-intent';
describe('cold open rendered intent (#4101)', () => {
  it('hydrates imported Auto from the resolved pair while preserving its sidecar intent', () => {
    const opened = {
      ...defaultAdjustmentModel(),
      whiteBalancePreset: 'Auto' as const,
      partialWhiteBalance: { version: 5 },
    };
    const metadata = {
      asShotTemperature: 5523,
      asShotTint: 7.4,
      importedTemperature: 5300.25,
      importedTint: 17.125,
    };
    const rendered = coldOpenRenderedModel(opened, metadata);
    expect(rendered.temperature).toBe(5300.25);
    expect(rendered.tint).toBe(17.125);
    expect(rendered.partialWhiteBalance).toEqual({ version: 5 });
    const authored = { ...rendered, temperature: 4800, partialWhiteBalance: null };
    expect(coldOpenRenderedModel(authored, metadata)).toEqual(authored);
  });
  it('hydrates only the opened model without claiming later edits were rendered', () => {
    const opened = { ...defaultAdjustmentModel(), profile: 'Neutral' as const };
    const live = { ...opened, profile: 'Auto' as const, exposure: 1.25 };
    const rendered = coldOpenRenderedModel(opened, { asShotTemperature: 5523, asShotTint: 7.4 });
    expect(rendered.profile).toBe('Neutral');
    expect(rendered.exposure).toBe(0);
    expect(rendered.temperature).toBe(5500);
    expect(rendered.tint).toBe(7);
    expect(rendered).not.toEqual(live);
    expect(opened.temperature).toBe(6500);
  });
  it('retains authored white balance on reopen', () => {
    const opened = {
      ...defaultAdjustmentModel(),
      whiteBalancePreset: 'Custom' as const,
      temperature: 4800,
      tint: 12,
    };
    expect(coldOpenRenderedModel(opened, { asShotTemperature: 5523, asShotTint: 7.4 })).toEqual(
      opened,
    );
  });
});
