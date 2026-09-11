/**
 * Synthetic image fixtures for tests, built with Maple's raw-pixel input.
 * Replaces the `sharp({ create: … })` pattern (#3499/#3500): every test that
 * needs "a small valid JPEG/PNG/AVIF" gets one without touching disk fixtures.
 */
import { maple } from 'maple';

export type Rgb = [number, number, number];

export function solidRgb(width: number, height: number, rgb: Rgb) {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set(rgb, i * 3);
  return { data, width, height, channels: 3 as const };
}

export function solidJpeg(width: number, height: number, rgb: Rgb, quality = 90): Promise<Buffer> {
  return maple(solidRgb(width, height, rgb))
    .toFormat('jpeg', { quality })
    .toBuffer();
}

export function solidPng(width: number, height: number, rgb: Rgb): Promise<Buffer> {
  return maple(solidRgb(width, height, rgb))
    .toFormat('png')
    .toBuffer();
}

export function solidAvif(width: number, height: number, rgb: Rgb, quality = 60): Promise<Buffer> {
  return maple(solidRgb(width, height, rgb))
    .toFormat('avif', { quality, effort: 1 })
    .toBuffer();
}
