// jsdom's `<canvas>.getContext('2d')` is null (same limitation documented in
// image-canvas.draw2d.spec.ts), so `qrcode`'s real canvas renderer can never
// actually draw here. The `qrcode` module is mocked so the component's own
// logic — invoking `toCanvas` with the right args, and reacting to its
// resolve/reject — is what's under test, not the third-party renderer.

import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toCanvas } from 'qrcode';

import { MuiQrCodeComponent } from './mui-qr-code.component';

vi.mock('qrcode', () => ({ toCanvas: vi.fn() }));

const mockedToCanvas = vi.mocked(toCanvas);

function render(): ComponentFixture<MuiQrCodeComponent> {
  TestBed.configureTestingModule({ imports: [MuiQrCodeComponent] });
  const fixture = TestBed.createComponent(MuiQrCodeComponent);
  fixture.componentRef.setInput('value', 'https://justmaple.app/pair/abc123');
  fixture.detectChanges();
  return fixture;
}

describe('MuiQrCodeComponent', () => {
  beforeEach(() => {
    mockedToCanvas.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the payload to the canvas with a quiet zone and high-contrast colors', async () => {
    mockedToCanvas.mockResolvedValue(undefined as never);
    const fixture = render();
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();

    expect(mockedToCanvas).toHaveBeenCalledTimes(1);
    const [canvasArg, valueArg, opts] = mockedToCanvas.mock.calls[0] as unknown as [
      HTMLCanvasElement,
      string,
      Record<string, unknown>,
    ];
    expect(canvasArg).toBeInstanceOf(HTMLCanvasElement);
    expect(valueArg).toBe('https://justmaple.app/pair/abc123');
    expect(opts).toMatchObject({
      margin: 4,
      color: { dark: '#000000', light: '#ffffff' },
    });
    expect(fixture.componentInstance.renderError()).toBeNull();
  });

  it('maps size to a pixel width passed to the renderer', async () => {
    mockedToCanvas.mockResolvedValue(undefined as never);
    const fixture = render();
    fixture.componentRef.setInput('size', 'lg');
    fixture.detectChanges();
    await Promise.resolve();
    expect(fixture.componentInstance.pixelSize()).toBe(192);
  });

  it('surfaces a render error message when the encoder rejects', async () => {
    mockedToCanvas.mockRejectedValue(new Error('payload too long'));
    const fixture = render();
    await fixture.whenStable();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.componentInstance.renderError()).toBe('payload too long');
    expect(fixture.nativeElement.querySelector('.error')?.textContent).toBe('payload too long');
  });

  it('exposes an accessible label derived from the payload by default', async () => {
    mockedToCanvas.mockResolvedValue(undefined as never);
    const fixture = render();
    await Promise.resolve();
    fixture.detectChanges();
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.getAttribute('aria-label')).toBe('QR code for https://justmaple.app/pair/abc123');
  });
});
