import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiScopesPanelComponent } from './mui-scopes-panel.component';
import type { MuiScopeSample } from './mui-scopes-panel.component';

// jsdom's `<canvas>.getContext('2d')` is null (see
// mui-histogram.component.spec.ts), so every plot's `draw()` no-ops safely
// — nothing here needs to stub the 2D context, only assert the four scopes
// mounted with the given sample.
const SAMPLE: MuiScopeSample = {
  histogram: { r: [1, 2], g: [2, 1], b: [1, 1] },
  waveformLuma: [0.2, 0.4, 0.6],
  parade: { r: [0.1, 0.2], g: [0.3, 0.4], b: [0.5, 0.6] },
  vectorscope: [
    { r: 0.5, g: 0.4, b: 0.3 },
    { r: 0.2, g: 0.6, b: 0.1 },
  ],
};

describe('MuiScopesPanelComponent', () => {
  it('renders all four scopes, each backed by a canvas, in Histogram/Waveform/Parade/Vectorscope order', () => {
    const fixture = TestBed.createComponent(MuiScopesPanelComponent);
    fixture.componentRef.setInput('sample', SAMPLE);
    fixture.detectChanges();

    const scopeTags = Array.from(fixture.nativeElement.querySelectorAll('.scope')).map((el) =>
      (el as HTMLElement).firstElementChild?.tagName.toLowerCase(),
    );
    expect(scopeTags).toEqual(['mui-text', 'mui-text', 'mui-text', 'mui-text']);

    expect(fixture.nativeElement.querySelector('mui-histogram')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-waveform')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-parade')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-vectorscope')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('canvas').length).toBe(4);
  });

  it('passes width/height through to the bar-style plots and derives the vectorscope size from height', () => {
    const fixture = TestBed.createComponent(MuiScopesPanelComponent);
    fixture.componentRef.setInput('sample', SAMPLE);
    fixture.componentRef.setInput('width', 180);
    fixture.componentRef.setInput('height', 48);
    fixture.detectChanges();

    const canvases = fixture.nativeElement.querySelectorAll(
      'canvas',
    ) as NodeListOf<HTMLCanvasElement>;
    expect(canvases[0].width).toBe(180); // histogram
    expect(canvases[0].height).toBe(48);
    expect(canvases[3].width).toBe(48); // vectorscope is square, sized off height
    expect(canvases[3].height).toBe(48);
  });
});
