import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiQrScannerComponent } from './mui-qr-scanner.component';

function render(): ComponentFixture<MuiQrScannerComponent> {
  TestBed.configureTestingModule({ imports: [MuiQrScannerComponent] });
  const fixture = TestBed.createComponent(MuiQrScannerComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiQrScannerComponent', () => {
  const originalMediaDevices = navigator.mediaDevices;

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      configurable: true,
    });
  });

  it('emits scanned with the trimmed paste value and clears the field', () => {
    const fixture = render();
    const scanned: string[] = [];
    fixture.componentInstance.scanned.subscribe((v) => scanned.push(v));

    const input = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    input.value = '  ABC-123  ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const useCodeButton = Array.from(fixture.nativeElement.querySelectorAll('.mui-button')).find(
      (el) => (el as HTMLElement).textContent?.includes('Use code'),
    ) as HTMLButtonElement;
    useCodeButton.click();

    expect(scanned).toEqual(['ABC-123']);
    expect(fixture.componentInstance.pasteValue()).toBe('');
  });

  it('ignores an empty/whitespace-only paste submit', () => {
    const fixture = render();
    const scanned: string[] = [];
    fixture.componentInstance.scanned.subscribe((v) => scanned.push(v));
    fixture.componentInstance.submitPaste();
    expect(scanned).toEqual([]);
  });

  it('falls back to a camera-unavailable error when mediaDevices is missing', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: undefined,
      configurable: true,
    });
    const fixture = render();
    await fixture.componentInstance.startCamera();
    fixture.detectChanges();
    expect(fixture.componentInstance.cameraActive()).toBe(false);
    expect(fixture.componentInstance.cameraError()).toContain('Camera not available');
  });

  it('requests getUserMedia and activates the camera on success', async () => {
    const fakeStream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });

    const fixture = render();
    await fixture.componentInstance.startCamera();
    fixture.detectChanges();

    expect(getUserMedia).toHaveBeenCalledWith({ video: true });
    expect(fixture.componentInstance.cameraActive()).toBe(true);
    expect(fixture.componentInstance.cameraError()).toBeNull();

    fixture.componentInstance.stopCamera();
    expect(fixture.componentInstance.cameraActive()).toBe(false);
  });

  it('surfaces a denied-permission error and stays on the paste fallback', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });

    const fixture = render();
    await fixture.componentInstance.startCamera();
    fixture.detectChanges();

    expect(fixture.componentInstance.cameraActive()).toBe(false);
    expect(fixture.componentInstance.cameraError()).toContain('denied');
    // The paste form is always present regardless of camera state.
    expect(fixture.nativeElement.querySelector('.paste mui-input')).toBeTruthy();
  });
});
