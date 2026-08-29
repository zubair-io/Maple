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
  computed,
  effect,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { toCanvas } from 'qrcode';

export type MuiQrCodeSize = 'sm' | 'md' | 'lg';

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

  constructor() {
    effect(() => {
      const value = this.value();
      const width = this.pixelSize();
      const canvasEl = this.canvas()?.nativeElement;
      if (!canvasEl) return;
      toCanvas(canvasEl, value, {
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
