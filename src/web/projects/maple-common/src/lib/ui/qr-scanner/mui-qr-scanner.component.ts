// MuiQrScanner — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Camera or paste payload capture, built from Input, Button, Canvas Surface.
//
// The paste path is the fully-supported path: a text field plus a "Use
// code" button that emits `scanned` with the trimmed payload — no camera or
// decode dependency required. The camera path is a real `getUserMedia`
// request (not a stub): on success it streams the live feed onto the
// `mui-canvas-surface` viewfinder via `requestAnimationFrame`; on failure
// (denied permission, no camera, or `navigator.mediaDevices` missing
// entirely — the case specs mock) it surfaces `cameraError` and the paste
// form stays available as the fallback since it's never hidden by camera
// state. Decoding a QR payload out of the live video frames would need a
// dedicated decoder library this workspace doesn't have (same "no existing
// QR encoder" gap noted in mui-qr-code's atom); wiring that in is future
// work, not something this molecule can respond to today.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  signal,
  viewChild,
  output,
} from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiCanvasSurfaceComponent } from '../canvas-surface/mui-canvas-surface.component';
import { MuiInputComponent } from '../input/mui-input.component';

@Component({
  selector: 'mui-qr-scanner',
  standalone: true,
  imports: [MuiButtonComponent, MuiCanvasSurfaceComponent, MuiInputComponent],
  templateUrl: './mui-qr-scanner.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiQrScannerComponent implements OnDestroy {
  readonly scanned = output<string>();

  readonly pasteValue = signal('');
  readonly cameraActive = signal(false);
  readonly cameraError = signal<string | null>(null);

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private stream: MediaStream | null = null;
  private canvasEl: HTMLCanvasElement | null = null;
  private frameHandle: number | null = null;

  ngOnDestroy(): void {
    this.stopCamera();
  }

  submitPaste(): void {
    const trimmed = this.pasteValue().trim();
    if (trimmed.length === 0) return;
    this.scanned.emit(trimmed);
    this.pasteValue.set('');
  }

  onCanvasReady(canvas: HTMLCanvasElement): void {
    this.canvasEl = canvas;
  }

  async startCamera(): Promise<void> {
    this.cameraError.set(null);
    const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (!getUserMedia) {
      this.cameraError.set('Camera not available on this device — paste the code instead.');
      return;
    }
    try {
      this.stream = await getUserMedia({ video: true });
      this.cameraActive.set(true);
      queueMicrotask(() => this.attachStream());
    } catch {
      this.cameraError.set('Camera access was denied — paste the code instead.');
      this.cameraActive.set(false);
    }
  }

  stopCamera(): void {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.cameraActive.set(false);
  }

  private attachStream(): void {
    const videoEl = this.video()?.nativeElement;
    if (!videoEl || !this.stream) return;
    videoEl.srcObject = this.stream;
    videoEl.play().catch(() => {
      // Autoplay can be blocked by the browser; the raw stream is still
      // attached and playback resumes once the user interacts, so this is
      // not a hard failure worth surfacing as `cameraError`.
    });
    this.drawFrame();
  }

  private drawFrame(): void {
    const videoEl = this.video()?.nativeElement;
    const canvas = this.canvasEl;
    if (!videoEl || !canvas || !this.cameraActive()) return;
    const ctx = canvas.getContext('2d');
    if (ctx && videoEl.videoWidth > 0) {
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    }
    this.frameHandle = requestAnimationFrame(() => this.drawFrame());
  }
}
