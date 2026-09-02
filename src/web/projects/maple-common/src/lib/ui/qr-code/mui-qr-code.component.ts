// MuiQrCode — the Maple UI design-system QR Code atom
// (unified-component-catalog.md §1.4; contract:
// docs/design/maple-ui/components/qr-code.md).
//
// Rendering path: the workspace had no existing QR encoder (checked
// `src/web`/`src/api` package.json and grepped for "qr" across
// `projects/**/*.ts` — the Apple/Windows pairing-QR flows are native-only,
// nothing to wrap on web). Writing a Reed–Solomon QR encoder from scratch is
// a project in itself and squarely out of scope, so this wraps the tiny
// zero-dependency `qrcode` npm package (`bun add qrcode` +
// `bun add -d @types/qrcode`) rather than reinventing it.
//
// Module color is intentionally hardcoded to pure black-on-white — not a
// design-system violation but a functional requirement independent of the
// app's dark theme: a camera scanner needs maximum, unambiguous contrast,
// and a themed dark/light-inverted code would be actively worse for
// scanning reliability regardless of surrounding chrome.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  InjectionToken,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { toCanvas } from 'qrcode';

export type MuiQrCodeSize = 'sm' | 'md' | 'lg';

// Injectable seam for the encoder call rather than calling `toCanvas`
// directly (#3034). Angular's esbuild-based Vitest test runner statically
// bundles relative-path source imports and explicitly disallows
// `vi.mock()` for them — it patches `vi.mock` to throw "not supported for
// relative imports ... use Angular TestBed for mocking dependencies" (see
// `@angular/build/src/builders/unit-test/runners/vitest/build-options.js`).
// Mocking the *external*, bare-specifier `qrcode` package itself via
// `vi.mock('qrcode', ...)` is nominally allowed, but proved unreliable
// under the same runner once more than one spec file in this library
// renders this component in the same, non-isolated (`isolate: false`)
// Vitest worker: module-level mock registration raced with which spec's
// copy of the component module got evaluated — and therefore linked
// against `qrcode` — first, so some runs called the real encoder no matter
// which file's mock "won." A DI token sidesteps module interception
// entirely: each spec's own `TestBed.configureTestingModule` provider
// override is scoped to that spec and torn down with the rest of the
// TestBed environment between tests, so there is nothing left for a later
// file to inherit.
export type QrCodeEncodeFn = typeof toCanvas;

export const QR_CODE_TO_CANVAS = new InjectionToken<QrCodeEncodeFn>('QR_CODE_TO_CANVAS', {
  providedIn: 'root',
  factory: () => toCanvas,
});

const SIZE_PX: Record<MuiQrCodeSize, number> = {
  sm: 96,
  md: 128,
  lg: 192,
};

// Modules of quiet-zone margin around the code — the spec's white space
// requirement that keeps a scanner's edge-detection from reading the QR as
// touching surrounding content.
const QUIET_ZONE_MODULES = 4;

@Component({
  selector: 'mui-qr-code',
  standalone: true,
  templateUrl: './mui-qr-code.component.html',
  host: { class: 'inline-flex' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiQrCodeComponent {
  readonly value = input.required<string>();
  readonly size = input<MuiQrCodeSize>('md');
  readonly ariaLabel = input<string | null>(null);

  // Deliberately NOT viewChild.required: the render effect below can be
  // scheduled before the first view render, and a required read would THROW
  // at that point — killing the effect run before the viewChild signal is
  // tracked as a dependency, so the effect never re-fires and the QR never
  // renders (recurring CI-only failure, #3027). The optional read returns
  // undefined pre-render, keeps the signal tracked, and the effect
  // deterministically re-runs once the canvas resolves.
  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  readonly pixelSize = computed(() => SIZE_PX[this.size()]);
  readonly renderError = signal<string | null>(null);

  private readonly toCanvasFn = inject(QR_CODE_TO_CANVAS);

  constructor() {
    effect(() => {
      const value = this.value();
      const width = this.pixelSize();
      const canvasEl = this.canvas()?.nativeElement;
      if (!canvasEl) return;
      this.toCanvasFn(canvasEl, value, {
        width,
        margin: QUIET_ZONE_MODULES,
        color: { dark: '#000000', light: '#ffffff' },
      })
        .then(() => this.renderError.set(null))
        .catch((error: unknown) =>
          this.renderError.set(error instanceof Error ? error.message : 'Failed to render QR code'),
        );
    });
  }
}
