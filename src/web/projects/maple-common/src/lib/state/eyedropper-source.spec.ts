import { signal } from '@angular/core';
import { eyedropperUnavailableForFile, eyedropperUnavailableReason } from './raw-extensions';
import { sampleWhiteBalanceInto, type WbSampleHost } from '../editor/editor-state.wb-sample';
import {
  sampleMaskRangeInto,
  type RangeSampleHost,
} from '../components/mask-overlay/mask-range-sample';

// #5146: a developed image must be refused up front, not at the RAW decoder.
const EYEDROPPER_NEEDS_RAW = eyedropperUnavailableReason('jpg');

describe('eyedropperUnavailableReason (#5146)', () => {
  it.each(['dng', 'cr3', 'nef', 'arw'])('lets a %s RAW through', (ext) => {
    expect(eyedropperUnavailableReason(ext)).toBeNull();
  });

  it.each(['jpg', 'jpeg', 'png', 'tif', 'heic', 'webp', 'x3f'])(
    'refuses a %s with a plain reason',
    (ext) => {
      expect(eyedropperUnavailableReason(ext)).toBe(EYEDROPPER_NEEDS_RAW);
    },
  );

  it('reads the extension from a file name, case-insensitively', () => {
    expect(eyedropperUnavailableForFile('IMG_1.JPG')).toBe(EYEDROPPER_NEEDS_RAW);
    expect(eyedropperUnavailableForFile('a.b.jpg')).toBe(EYEDROPPER_NEEDS_RAW);
    expect(eyedropperUnavailableForFile('no-extension')).toBe(EYEDROPPER_NEEDS_RAW);
    expect(eyedropperUnavailableForFile('IMG_1.CR3')).toBeNull();
    expect(eyedropperUnavailableForFile(undefined)).toBeNull();
  });
});

describe.each(['photo.jpg', 'photo.png'])('white-balance sampler on %s (#5146)', (filename) => {
  it('never reaches the RAW sampler and says why', async () => {
    const sampleWhiteBalance = vi.fn();
    const autoResult = signal<string | null>('stale');
    const host = {
      wbSampleInFlight: signal(false),
      autoResult,
      imageId: () => 'a',
      currentAdjustment: () => ({}),
      library: {
        assets: () => [{ id: 'a', filename }],
        bytesFor: vi.fn(),
        bytesForAsset: vi.fn(),
      },
      pipeline: { sampleWhiteBalance },
    } as unknown as WbSampleHost;

    await expect(sampleWhiteBalanceInto(host, 'a', 0.5, 0.5)).resolves.toBe(false);

    expect(sampleWhiteBalance).not.toHaveBeenCalled();
    expect(host.library.bytesFor).not.toHaveBeenCalled();
    expect(autoResult()).toBe(EYEDROPPER_NEEDS_RAW);
  });
});

describe.each(['jpg', 'png'])('mask colour-range sampler on a .%s (#5146)', (ext) => {
  it('never reaches the RAW sampler and says why', async () => {
    const sampleMaskRange = vi.fn();
    const setMessage = vi.fn();
    const host = {
      focusedAssetId: () => 'a',
      assetExtension: () => ext,
      bytes: vi.fn(),
      setMessage,
      sampleMaskRange,
    } as unknown as RangeSampleHost;

    await expect(sampleMaskRangeInto(host, 0.5, 0.5)).resolves.toBe(false);

    expect(sampleMaskRange).not.toHaveBeenCalled();
    expect(host.bytes).not.toHaveBeenCalled();
    expect(setMessage).toHaveBeenLastCalledWith(EYEDROPPER_NEEDS_RAW);
  });
});
