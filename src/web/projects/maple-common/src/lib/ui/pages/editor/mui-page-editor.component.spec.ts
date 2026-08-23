import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageEditorComponent } from './mui-page-editor.component';

describe('MuiPageEditorComponent', () => {
  it('renders Image Canvas + Control Surface + Filmstrip in Center and Inspector/Adjustments in Detail', () => {
    const fixture = TestBed.createComponent(MuiPageEditorComponent);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[slot=sidebar] mui-tool-dock')).toBeTruthy();
    expect(el.querySelector('mui-image-canvas')).toBeTruthy();
    expect(el.querySelector('mui-control-surface')).toBeTruthy();
    expect(el.querySelector('mui-filmstrip')).toBeTruthy();
    expect(
      el.querySelector('[slot=detail] mui-inspector-panel mui-adjustments-panel'),
    ).toBeTruthy();
    expect(el.querySelector('mui-value-hud')).toBeNull();
  });

  it('shows the Value HUD with the changed slider when the Control Surface fires sliderChanged', () => {
    const fixture = TestBed.createComponent(MuiPageEditorComponent);
    fixture.detectChanges();

    fixture.componentInstance.onControlSliderChanged({ id: 'exposure', value: 1.2 });
    fixture.detectChanges();

    expect(fixture.componentInstance.hudVisible()).toBe(true);
    expect(fixture.componentInstance.hudLabel()).toBe('exposure');
    expect(fixture.componentInstance.hudValue()).toBe('1.2');
    expect(fixture.nativeElement.querySelector('mui-value-hud')).toBeTruthy();
  });

  it('swaps the canvas source when a Filmstrip frame is selected', () => {
    const fixture = TestBed.createComponent(MuiPageEditorComponent);
    fixture.detectChanges();

    const before = fixture.componentInstance.canvasSrc();
    fixture.componentInstance.onFilmstripActivated('frame-2');
    fixture.detectChanges();

    expect(fixture.componentInstance.canvasSrc()).not.toBe(before);
    expect(fixture.componentInstance.filmstripActiveId()).toBe('frame-2');
  });
});
