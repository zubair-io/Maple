import { describe, it, expect } from 'bun:test';
import {
  isVideoFilename,
  VIDEO_EXTS,
  isStubImageFilename,
  STUB_IMAGE_EXTS,
  isAudioFilename,
  AUDIO_EXTS,
  isNoPreviewFilename,
} from './media-types.ts';

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
    for (const name of [
      'photo.jpg',
      'photo.jpeg',
      'scan.tiff',
      'frame.heic',
      'shot.dng',
      'a.cr3',
    ]) {
      expect(isVideoFilename(name)).toBe(false);
    }
  });

  it('does not match extensionless names', () => {
    expect(isVideoFilename('README')).toBe(false);
    expect(isVideoFilename('')).toBe(false);
  });
});

describe('isStubImageFilename', () => {
  it('matches the metadata-only stub image formats', () => {
    for (const ext of STUB_IMAGE_EXTS) {
      expect(isStubImageFilename(`file${ext}`)).toBe(true);
    }
  });

  it('is case-insensitive on the extension', () => {
    expect(isStubImageFilename('Scan.EIP')).toBe(true);
    expect(isStubImageFilename('Clip.BRAW')).toBe(true);
  });

  it('matches on a full path, not just a bare filename', () => {
    expect(isStubImageFilename('/srv/photos/2026/logo.ai')).toBe(true);
  });

  it('does not match decodable still-image, RAW, or video extensions', () => {
    for (const name of ['photo.jpg', 'shot.dng', 'a.cr3', 'clip.mov', 'clip.mp4']) {
      expect(isStubImageFilename(name)).toBe(false);
    }
  });

  it('does not match extensionless names', () => {
    expect(isStubImageFilename('README')).toBe(false);
    expect(isStubImageFilename('')).toBe(false);
  });
});

describe('isAudioFilename', () => {
  it('matches the recognised audio formats', () => {
    for (const ext of AUDIO_EXTS) {
      expect(isAudioFilename(`track${ext}`)).toBe(true);
    }
  });

  it('is case-insensitive on the extension', () => {
    expect(isAudioFilename('Track.MP3')).toBe(true);
    expect(isAudioFilename('Voice.WAV')).toBe(true);
  });

  it('matches on a full path, not just a bare filename', () => {
    expect(isAudioFilename('/srv/audio/2026/voice-memo.m4a')).toBe(true);
  });

  it('does not match image, RAW, video, or stub-image extensions', () => {
    for (const name of ['photo.jpg', 'shot.dng', 'clip.mov', 'scan.eip', 'logo.ai']) {
      expect(isAudioFilename(name)).toBe(false);
    }
  });

  it('does not match extensionless names', () => {
    expect(isAudioFilename('README')).toBe(false);
    expect(isAudioFilename('')).toBe(false);
  });
});

describe('isNoPreviewFilename', () => {
  it('is true for every video, stub-image, and audio extension', () => {
    for (const ext of [...VIDEO_EXTS, ...STUB_IMAGE_EXTS, ...AUDIO_EXTS]) {
      expect(isNoPreviewFilename(`file${ext}`)).toBe(true);
    }
  });

  it('is false for decodable still-image, RAW, PSD/PSB/HDR extensions', () => {
    for (const name of ['photo.jpg', 'shot.dng', 'a.cr3', 'scan.psd', 'scene.hdr']) {
      expect(isNoPreviewFilename(name)).toBe(false);
    }
  });
});
