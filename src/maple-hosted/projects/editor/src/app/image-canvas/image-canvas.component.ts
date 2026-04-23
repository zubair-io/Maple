// ImageCanvas — center column; zoom + pan + before/after divider.
// Placeholder gradient imagery; real raw-wasm rendering deferred to P4.

import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { LibraryStateService } from '@maple-common';
import { ImageCanvasService } from './image-canvas.service';

@Component({
  selector: 'editor-image-canvas',
  standalone: true,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      min-width: 0;
      position: relative;
      overflow: hidden;
      background: #080706;
    }

    /* Toolbar */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      height: 34px;
      background: var(--maple-surface);
      border-bottom: 0.5px solid var(--maple-border);
      flex-shrink: 0;
    }
    .toolbar-spacer { flex: 1; }
    .zoom-label {
      font-family: var(--maple-font-mono);
      font-size: 10px;
      color: var(--maple-text-muted);
    }
    .tool-btn {
      width: 24px;
      height: 24px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-family: var(--maple-font);
      font-size: 11px;
      color: var(--maple-text-muted);
      border: 0.5px solid var(--maple-border);
      background: var(--maple-surface-alt);
      transition: background 100ms;
    }
    .tool-btn:hover { background: var(--maple-surface-hover); color: var(--maple-text-main); }
    .tool-btn.active { background: var(--maple-primary-dim); color: var(--maple-primary); border-color: var(--maple-primary); }

    /* Canvas wrapper */
    .canvas-wrap {
      flex: 1;
      position: relative;
      min-height: 0;
      overflow: hidden;
      cursor: grab;
      user-select: none;
    }
    .canvas-wrap:active { cursor: grabbing; }
    .canvas-wrap canvas { display: block; position: absolute; top: 50%; left: 50%; }

    /* Before/after divider */
    .ba-divider {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      background: rgba(255,255,255,0.8);
      transform: translateX(-50%);
      cursor: ew-resize;
      z-index: 10;
    }
    .ba-handle {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 20px;
      height: 40px;
      background: rgba(255,255,255,0.9);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: #333;
      pointer-events: none;
    }

    /* Filename overlay */
    .filename-overlay {
      position: absolute;
      left: 12px;
      bottom: 10px;
      font-family: var(--maple-font-mono);
      font-size: 10px;
      color: rgba(255,255,255,0.35);
      pointer-events: none;
      z-index: 5;
    }
  `],
  template: `
    <!-- Toolbar -->
    <div class="toolbar">
      <span class="zoom-label">{{ zoomLabel() }}</span>
      <div class="tool-btn" (click)="canvasSvc.zoomOut()" title="Zoom out">−</div>
      <div class="tool-btn" (click)="canvasSvc.resetView()" title="Fit">⊡</div>
      <div class="tool-btn" (click)="canvasSvc.zoomIn()" title="Zoom in">+</div>
      <div class="toolbar-spacer"></div>
      <div class="tool-btn"
        [class.active]="canvasSvc.showBeforeAfter()"
        (click)="canvasSvc.toggleBeforeAfter()"
        title="Before/After (b)">B/A</div>
    </div>

    <!-- Canvas area -->
    <div class="canvas-wrap" #wrap
      (wheel)="onWheel($event)"
      (mousedown)="onMouseDown($event)"
      (mousemove)="onMouseMove($event)"
      (mouseup)="onMouseUp()"
      (mouseleave)="onMouseUp()">
      <canvas #canvas></canvas>

      <!-- Before/after divider -->
      @if (canvasSvc.showBeforeAfter()) {
        <div class="ba-divider"
          [style.left.%]="(canvasSvc.beforeAfterSplitX() ?? 0.5) * 100"
          (mousedown)="onDividerDrag($event)">
          <div class="ba-handle">⇔</div>
        </div>
      }

      <!-- Filename overlay -->
      @if (state.focusedAsset()) {
        <div class="filename-overlay">{{ state.focusedAsset()?.filename }}</div>
      }
    </div>
  `,
})
export class ImageCanvasComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('wrap')   wrapRef!:   ElementRef<HTMLElement>;

  state     = inject(LibraryStateService);
  canvasSvc = inject(ImageCanvasService);

  private ro?: ResizeObserver;
  private wrapW = signal<number>(800);
  private wrapH = signal<number>(600);
  private dragging = false;
  private dragLast = { x: 0, y: 0 };
  private dividerDragging = false;
  private cleanupEffect?: () => void;

  // Zoom factor (numeric, 'fit' → computed)
  zoomLabel = computed(() => {
    const z = this.canvasSvc.zoom();
    return z === 'fit' ? 'Fit' : `${Math.round((z as number) * 100)}%`;
  });

  private effectivePx = computed(() => {
    const z = this.canvasSvc.zoom();
    const asset = this.state.focusedAsset();
    const W = this.wrapW();
    const H = this.wrapH();
    const aw = asset?.width  ?? 6240;
    const ah = asset?.height ?? 4160;
    if (z === 'fit') {
      const scale = Math.min(W / aw, H / ah, 1);
      return { scale, canvasW: Math.round(aw * scale), canvasH: Math.round(ah * scale) };
    }
    const scale = z as number;
    return { scale, canvasW: Math.round(aw * scale), canvasH: Math.round(ah * scale) };
  });

  ngAfterViewInit(): void {
    // Observe container resize
    this.ro = new ResizeObserver(entries => {
      for (const e of entries) {
        this.wrapW.set(e.contentRect.width);
        this.wrapH.set(e.contentRect.height);
      }
    });
    this.ro.observe(this.wrapRef.nativeElement);
    this.wrapW.set(this.wrapRef.nativeElement.clientWidth  || 800);
    this.wrapH.set(this.wrapRef.nativeElement.clientHeight || 600);

    // Re-render whenever any of these signals change
    const e = effect(() => {
      const _ = this.state.focusedAsset();
      const __ = this.canvasSvc.zoom();
      const ___ = this.canvasSvc.pan();
      const ____ = this.canvasSvc.beforeAfterSplitX();
      const _____ = this.wrapW();
      const ______ = this.wrapH();
      this.draw();
    });
    this.cleanupEffect = () => e.destroy();
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.cleanupEffect?.();
  }

  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const { canvasW, canvasH } = this.effectivePx();
    canvas.width  = canvasW;
    canvas.height = canvasH;

    // Position canvas in center + pan
    const pan = this.canvasSvc.pan();
    canvas.style.transform = `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const asset = this.state.focusedAsset();
    const split = this.canvasSvc.beforeAfterSplitX();

    if (split !== null) {
      // Before half
      this.drawGradient(ctx, asset?.thumbnailGradient, 0, 0, Math.round(canvasW * split), canvasH, 0);
      // After half (slightly lightened to suggest processing)
      this.drawGradient(ctx, asset?.thumbnailGradient, Math.round(canvasW * split), 0, canvasW - Math.round(canvasW * split), canvasH, 15);
    } else {
      this.drawGradient(ctx, asset?.thumbnailGradient, 0, 0, canvasW, canvasH, 0);
    }
  }

  private drawGradient(
    ctx: CanvasRenderingContext2D,
    gradientUrl: string | undefined,
    x: number, y: number, w: number, h: number,
    lightenBy: number,
  ): void {
    if (w <= 0 || h <= 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    if (gradientUrl) {
      const img = new Image();
      img.onload = () => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.drawImage(img, x, y, w, h);
        if (lightenBy > 0) {
          ctx.fillStyle = `rgba(255,255,255,${lightenBy / 100})`;
          ctx.fillRect(x, y, w, h);
        }
        ctx.restore();
      };
      img.src = gradientUrl;
    } else {
      const grd = ctx.createLinearGradient(x, y, x + w, y + h);
      grd.addColorStop(0, '#3a4050');
      grd.addColorStop(1, '#181c22');
      ctx.fillStyle = grd;
      ctx.fillRect(x, y, w, h);
    }

    if (lightenBy > 0) {
      ctx.fillStyle = `rgba(255,255,255,${lightenBy / 100})`;
      ctx.fillRect(x, y, w, h);
    }

    ctx.restore();
  }

  onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.deltaY < 0) this.canvasSvc.zoomIn();
    else this.canvasSvc.zoomOut();
  }

  onMouseDown(e: MouseEvent): void {
    if (e.button === 0 || e.button === 1) {
      this.dragging = true;
      this.dragLast = { x: e.clientX, y: e.clientY };
    }
  }

  onMouseMove(e: MouseEvent): void {
    if (this.dragging) {
      const dx = e.clientX - this.dragLast.x;
      const dy = e.clientY - this.dragLast.y;
      this.dragLast = { x: e.clientX, y: e.clientY };
      this.canvasSvc.applyPanDelta(dx, dy);
    }
    if (this.dividerDragging) {
      const rect = this.wrapRef.nativeElement.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      this.canvasSvc.setSplit(frac);
    }
  }

  onMouseUp(): void {
    this.dragging = false;
    this.dividerDragging = false;
  }

  onDividerDrag(e: MouseEvent): void {
    e.stopPropagation();
    this.dividerDragging = true;
    this.dragLast = { x: e.clientX, y: e.clientY };
  }
}
