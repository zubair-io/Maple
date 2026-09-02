// jsdom's `<canvas>.getContext('2d')` is null (same limitation documented in
// image-canvas.draw2d.spec.ts), so `qrcode`'s real canvas renderer can never
// actually draw here. The encoder call is injected (`QR_CODE_TO_CANVAS`,
// #3034) and overridden via a `TestBed` provider rather than mocked at the
// module level with `vi.mock` — see that token's doc comment in the
// component for why: Angular's Vitest runner disallows `vi.mock` for
// relative-path imports outright, and mocking the external `qrcode`
// package itself proved unreliable once more than one spec file in this
// library rendered the component in the same, non-isolated Vitest worker.
// A `TestBed` provider override has no such cross-file interference — it's
// scoped to, and torn down with, each test's own testing module.

import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QrCodeEncodeFn } from './mui-qr-code.component';
import { MuiQrCodeComponent, QR_CODE_TO_CANVAS } from './mui-qr-code.component';

const mockedToCanvas = vi.fn<QrCodeEncodeFn>();

function render(): ComponentFixture<MuiQrCodeComponent> {
  TestBed.configureTestingModule({
    imports: [MuiQrCodeComponent],
    providers: [{ provide: QR_CODE_TO_CANVAS, useValue: mockedToCanvas }],
  });
  const fixture = TestBed.createComponent(MuiQrCodeComponent);
  fixture.componentRef.setInput('value', 'https://justmaple.app/pair/abc123');
  fixture.detectChanges();
  return fixture;
}

// The component's render call happens inside a constructor `effect()`.
// `TestBed.tick()` deterministically flushes pending effects (unlike
// `fixture.whenStable()` + a bare microtask wait, which raced the effect
// scheduler under zoneless on CI). Once the effect has run, `toCanvas` has
// been invoked and its mocked promise is in hand — awaiting that same
// promise instance guarantees the component's own `.then`/`.catch` handler
// (registered before the test's `await`) has already run, since promise
// reactions fire in the order they were attached.
async function flushRender(fixture: ComponentFixture<MuiQrCodeComponent>): Promise<void> {
  TestBed.tick();
  await mockedToCanvas.mock.results[0]?.value?.catch(() => undefined);
  fixture.detectChanges();
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
    await flushRender(fixture);

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
    TestBed.tick();
    expect(fixture.componentInstance.pixelSize()).toBe(192);
  });

  it('surfaces a render error message when the encoder rejects', async () => {
    mockedToCanvas.mockRejectedValue(new Error('payload too long'));
    const fixture = render();
    await flushRender(fixture);

    expect(fixture.componentInstance.renderError()).toBe('payload too long');
    expect(fixture.nativeElement.querySelector('.error')?.textContent).toBe('payload too long');
  });

  it('exposes an accessible label derived from the payload by default', async () => {
    mockedToCanvas.mockResolvedValue(undefined as never);
    const fixture = render();
    await flushRender(fixture);
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.getAttribute('aria-label')).toBe('QR code for https://justmaple.app/pair/abc123');
  });

  // Regression for #3027: on CI the effect scheduler sometimes flushed the
  // render effect BEFORE the first view render. With `viewChild.required`
  // that read threw, the throw prevented the viewChild signal from being
  // tracked, and the effect never re-ran — so `toCanvas` was never called
  // no matter how much the test flushed afterwards. This drives the effect
  // queue ahead of the test's own `detectChanges()` and asserts the render
  // still lands exactly once with no error.
  it('still renders when effects are flushed before the first detectChanges', async () => {
    mockedToCanvas.mockResolvedValue(undefined as never);
    TestBed.configureTestingModule({
      imports: [MuiQrCodeComponent],
      providers: [{ provide: QR_CODE_TO_CANVAS, useValue: mockedToCanvas }],
    });
    const fixture = TestBed.createComponent(MuiQrCodeComponent);
    fixture.componentRef.setInput('value', 'https://justmaple.app/pair/abc123');
    TestBed.tick(); // flush effects before the test ever calls detectChanges

    fixture.detectChanges();
    await flushRender(fixture);
    expect(mockedToCanvas).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.renderError()).toBeNull();
  });
});
