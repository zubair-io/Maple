import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MuiConnectionGraphComponent,
  type MuiConnectionGraphLink,
  type MuiConnectionGraphNode,
} from './mui-connection-graph.component';

const NODES: readonly MuiConnectionGraphNode[] = [
  { id: 'a', label: 'A', x: 0.1, y: 0.1 },
  { id: 'b', label: 'B', x: 0.5, y: 0.4 },
  { id: 'c', label: 'C', x: 0.8, y: 0.1 },
  { id: 'd', label: 'D', x: 0.2, y: 0.7 },
];

const LINKS: readonly MuiConnectionGraphLink[] = [
  { source: 'a', target: 'b' },
  { source: 'b', target: 'c' },
  { source: 'b', target: 'd' },
];

function fakeCtx() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
  };
}

describe('MuiConnectionGraphComponent', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    ctx = fakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws one line per link and one circle + label per node', () => {
    const fixture = TestBed.createComponent(MuiConnectionGraphComponent);
    fixture.componentRef.setInput('nodes', NODES);
    fixture.componentRef.setInput('links', LINKS);
    fixture.detectChanges();

    expect(ctx.clearRect).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalledTimes(3); // 3 links
    expect(ctx.arc).toHaveBeenCalledTimes(4); // 4 nodes
    expect(ctx.fillText).toHaveBeenCalledTimes(4);
    expect(ctx.fillText.mock.calls.map((call: unknown[]) => call[0])).toEqual(['A', 'B', 'C', 'D']);
  });

  it('skips a link referencing an unknown node id without throwing', () => {
    const fixture = TestBed.createComponent(MuiConnectionGraphComponent);
    fixture.componentRef.setInput('nodes', NODES);
    fixture.componentRef.setInput('links', [...LINKS, { source: 'a', target: 'ghost' }]);
    expect(() => fixture.detectChanges()).not.toThrow();
    expect(ctx.lineTo).toHaveBeenCalledTimes(3); // the bad link is skipped
  });

  it('omits labels when showLabels is false', () => {
    const fixture = TestBed.createComponent(MuiConnectionGraphComponent);
    fixture.componentRef.setInput('nodes', NODES);
    fixture.componentRef.setInput('links', LINKS);
    fixture.componentRef.setInput('showLabels', false);
    fixture.detectChanges();

    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.arc).toHaveBeenCalledTimes(4);
  });

  it('places node positions proportionally within the canvas size', () => {
    const fixture = TestBed.createComponent(MuiConnectionGraphComponent);
    fixture.componentRef.setInput('nodes', [{ id: 'x', label: 'X', x: 0.5, y: 0.5 }]);
    fixture.componentRef.setInput('links', []);
    fixture.componentRef.setInput('width', 200);
    fixture.componentRef.setInput('height', 100);
    fixture.detectChanges();

    const [x, y] = ctx.arc.mock.calls[0];
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(50);
  });
});
