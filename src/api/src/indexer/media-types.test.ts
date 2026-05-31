import { describe, it, expect } from 'bun:test';
import { isVideoFilename, VIDEO_EXTS } from './media-types.ts';

describe('isVideoFilename', () => {
  it('matches common video containers', () => {
    for (const ext of VIDEO_EXTS) {
      expect(isVideoFilename(`clip${ext}`)).toBe(true);
    }
  });

  it('is case-insensitive on the extension', () => {
    expect(isVideoFilename('IMG_3087.MOV')).toBe(true);
    expect(isVideoFilename('IMG_3127.Mp4')).toBe(true);
  });

  it('matches on a full path, not just a bare filename', () => {
    expect(isVideoFilename('/srv/photos/2026/Town/05-05/IMG_3087.MOV')).toBe(true);
  });

  it('does not match still-image or RAW extensions', () => {
    for (const name of ['photo.jpg', 'photo.jpeg', 'scan.tiff', 'frame.heic', 'shot.dng', 'a.cr3']) {
      expect(isVideoFilename(name)).toBe(false);
    }
  });

  it('does not match extensionless names', () => {
    expect(isVideoFilename('README')).toBe(false);
    expect(isVideoFilename('')).toBe(false);
  });
});
