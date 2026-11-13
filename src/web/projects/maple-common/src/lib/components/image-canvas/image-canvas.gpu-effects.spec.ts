import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';

import { wireScopeSampleEffect } from './image-canvas.gpu-effects';
import type { GpuPresentHost } from './image-canvas.gpu-present';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';

function scopeHost() {
  const scopeSample = signal<DecodedImage | null>(null);
  const currentPixels = signal<DecodedImage | null>(null);
  const host = {
    pipeline: { scopeSample },
    canvasSvc: { currentPixels },
  } as unknown as GpuPresentHost;
  return { host, scopeSample, currentPixels };
}

describe('wireScopeSampleEffect (#3397)', () => {
  it('publishes an out-of-band sample into currentPixels', () => {
    const { host, scopeSample, currentPixels } = scopeHost();
    const stop = wireScopeSampleEffect(host, TestBed.inject(Injector));
    TestBed.flushEffects();
    expect(currentPixels()).toBeNull();

    scopeSample.set({
      width: 1,
      height: 1,
      rgb: new Uint8Array([99, 88, 77]),
      asShotTemperature: 6500,
      asShotTint: 0,
    });
    TestBed.flushEffects();

    expect(Array.from(currentPixels()!.rgb)).toEqual([99, 88, 77]);
    stop();
  });

  it('a null sample leaves the previous pixels in place', () => {
    const { host, scopeSample, currentPixels } = scopeHost();
    const stop = wireScopeSampleEffect(host, TestBed.inject(Injector));

    scopeSample.set({
      width: 1,
      height: 1,
      rgb: new Uint8Array([1, 2, 3]),
      asShotTemperature: 6500,
      asShotTint: 0,
    });
    TestBed.flushEffects();

    // A readback miss must not blank the scopes to their pseudo fallback.
    scopeSample.set(null);
    TestBed.flushEffects();
    expect(Array.from(currentPixels()!.rgb)).toEqual([1, 2, 3]);
    stop();
  });
});
