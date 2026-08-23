import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiInfoPanelComponent } from './mui-info-panel.component';

function render(): ComponentFixture<MuiInfoPanelComponent> {
  TestBed.configureTestingModule({ imports: [MuiInfoPanelComponent] });
  const fixture = TestBed.createComponent(MuiInfoPanelComponent);
  fixture.componentRef.setInput('filename', 'DSC_0001.dng');
  fixture.componentRef.setInput('metadata', [{ label: 'Camera', value: 'Hasselblad L3D-100c' }]);
  fixture.componentRef.setInput('keywords', [{ id: 'k1', label: 'Sunset' }]);
  fixture.detectChanges();
  return fixture;
}

describe('MuiInfoPanelComponent', () => {
  it('shows a centered spinner instead of the body while loading', () => {
    const fixture = render();
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.loading mui-spinner')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-label-value-grid')).toBeNull();
  });

  it('renders the metadata grid, keywords, and filename once loaded', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.loading')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Camera');
    expect(fixture.nativeElement.textContent).toContain('Hasselblad L3D-100c');
    expect(fixture.nativeElement.textContent).toContain('Sunset');
    expect(fixture.nativeElement.querySelector('.display').textContent).toContain('DSC_0001.dng');
  });

  it('commits a rename and emits renamed', () => {
    const fixture = render();
    const renamed: string[] = [];
    fixture.componentInstance.renamed.subscribe((v) => renamed.push(v));

    fixture.nativeElement.querySelector('.mui-inline-rename-field .display').click();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector(
      '.mui-inline-rename-field input.control',
    );
    input.value = 'sunset-final.dng';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(renamed).toEqual(['sunset-final.dng']);
    expect(fixture.componentInstance.filename()).toBe('sunset-final.dng');
  });

  it('rating and flag are two-way bound', () => {
    const fixture = render();
    fixture.componentInstance.rating.set(4);
    fixture.componentInstance.flag.set('pick');
    fixture.detectChanges();
    expect(fixture.componentInstance.rating()).toBe(4);
    expect(fixture.componentInstance.flag()).toBe('pick');
  });

  it('only renders the histogram when one is provided', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-histogram')).toBeNull();

    fixture.componentRef.setInput('histogram', { r: [1, 2], g: [1, 2], b: [1, 2] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-histogram')).toBeTruthy();
  });

  it('adding and removing a keyword emits keywordAdded / keywordRemoved', () => {
    const fixture = render();
    const added: string[] = [];
    const removed: string[] = [];
    fixture.componentInstance.keywordAdded.subscribe((v) => added.push(v));
    fixture.componentInstance.keywordRemoved.subscribe((v) => removed.push(v));

    const addInput: HTMLInputElement = fixture.nativeElement.querySelector(
      '.mui-keyword-row .add input.control',
    );
    addInput.value = 'Golden Hour';
    addInput.dispatchEvent(new Event('input'));
    addInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(added).toEqual(['Golden Hour']);

    const removeButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '.mui-keyword-row .chip .remove',
    );
    removeButton.click();
    fixture.detectChanges();
    expect(removed).toEqual(['k1']);
  });
});
