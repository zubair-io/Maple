// MuiConnectionGraph — the Maple UI design-system Connection Graph data plot
// (unified-component-catalog.md §2.6; a plot primitive). A static (force-free)
// node-link graph: the caller supplies each node's normalized (0..1)
// position directly — this component only draws links, node circles, and
// labels. Colors are resolved from `--color-*` tokens (see
// mui-waveform's `resolveColor`); label typography reads the canvas
// element's own inherited computed font, since Canvas 2D text can't consume
// CSS custom properties directly.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  viewChild,
} from '@angular/core';
import { beginPlotDraw, resolveColor } from '../internal/plot-canvas';

export interface MuiConnectionGraphNode {
  readonly id: string;
  readonly label: string;
  /** Normalized 0..1 position within the plot. */
  readonly x: number;
  readonly y: number;
}

export interface MuiConnectionGraphLink {
  readonly source: string;
  readonly target: string;
}

/** A node's position in canvas pixels (post `x/y * width/height` scaling). */
interface NodePoint {
  readonly x: number;
  readonly y: number;
}

@Component({
  selector: 'mui-connection-graph',
  standalone: true,
  templateUrl: './mui-connection-graph.component.html',
  styleUrl: './mui-connection-graph.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiConnectionGraphComponent {
  readonly nodes = input.required<readonly MuiConnectionGraphNode[]>();
  readonly links = input.required<readonly MuiConnectionGraphLink[]>();
  readonly width = input<number>(160);
  readonly height = input<number>(96);
  readonly showLabels = input<boolean>(true);

  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    effect(() => {
      this.nodes();
      this.links();
      this.width();
      this.height();
      this.showLabels();
      this.draw();
    });
  }

  private draw(): void {
    const w = this.width();
    const h = this.height();
    const frame = beginPlotDraw(this.canvas(), w, h);
    if (!frame) return;
    const { canvasEl, ctx } = frame;

    const nodesById = new Map(this.nodes().map((node) => [node.id, node]));
    const toPx = (node: MuiConnectionGraphNode): NodePoint => ({ x: node.x * w, y: node.y * h });

    this.drawLinks(ctx, canvasEl, nodesById, toPx);
    this.drawNodes(ctx, canvasEl, toPx);
  }

  private drawLinks(
    ctx: CanvasRenderingContext2D,
    canvasEl: HTMLCanvasElement,
    nodesById: ReadonlyMap<string, MuiConnectionGraphNode>,
    toPx: (node: MuiConnectionGraphNode) => NodePoint,
  ): void {
    ctx.strokeStyle = resolveColor(canvasEl, 'var(--color-border)');
    ctx.lineWidth = 1.5;
    for (const link of this.links()) {
      const source = nodesById.get(link.source);
      const target = nodesById.get(link.target);
      if (!source || !target) continue;
      const a = toPx(source);
      const b = toPx(target);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  /** Draws each node's dot and (if `showLabels()`) its label immediately
   * after, so a later node's dot can never paint over an earlier node's
   * label — matches drawing a single dot+label pass per node rather than
   * batching all dots before all labels. */
  private drawNodes(
    ctx: CanvasRenderingContext2D,
    canvasEl: HTMLCanvasElement,
    toPx: (node: MuiConnectionGraphNode) => NodePoint,
  ): void {
    const accent = resolveColor(canvasEl, 'var(--color-primary)');
    const showLabels = this.showLabels();
    const labelStyle = showLabels ? this.labelStyle(canvasEl) : null;

    for (const node of this.nodes()) {
      const p = toPx(node);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();

      if (labelStyle) this.drawLabel(ctx, node, p, labelStyle);
    }
  }

  private labelStyle(canvasEl: HTMLCanvasElement): {
    readonly color: string;
    readonly font: string;
  } {
    return {
      color: resolveColor(canvasEl, 'var(--color-text-main)'),
      font: getComputedStyle(canvasEl).font || '11px sans-serif',
    };
  }

  private drawLabel(
    ctx: CanvasRenderingContext2D,
    node: MuiConnectionGraphNode,
    p: NodePoint,
    style: { readonly color: string; readonly font: string },
  ): void {
    ctx.font = style.font;
    ctx.fillStyle = style.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(node.label, p.x, p.y + 8);
  }
}
