import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiEnrichmentPanelComponent } from './mui-enrichment-panel.component';

function render(): ComponentFixture<MuiEnrichmentPanelComponent> {
  TestBed.configureTestingModule({ imports: [MuiEnrichmentPanelComponent] });
  const fixture = TestBed.createComponent(MuiEnrichmentPanelComponent);
  fixture.componentRef.setInput('description', 'A hiker crossing a ridge at sunset.');
  fixture.componentRef.setInput('people', [{ id: 'p1', label: 'Jordan' }]);
  fixture.componentRef.setInput('visionLabels', [{ id: 'v1', label: 'Mountain' }]);
  fixture.detectChanges();
  return fixture;
}

describe('MuiEnrichmentPanelComponent', () => {
  it('shows no status badge when idle, and the right label per status otherwise', () => {
    const fixture = render();
    // Scoped to `.description-group` — Faces Row's person chips are also
    // `<mui-badge>`s under the hood, so an unscoped query would false-match.
    const statusBadge = (): Element | null =>
      fixture.nativeElement.querySelector('.description-group mui-badge');
    expect(statusBadge()).toBeNull();

    fixture.componentRef.setInput('descriptionStatus', 'generating');
    fixture.detectChanges();
    expect(statusBadge()?.textContent).toContain('Generating…');

    fixture.componentRef.setInput('descriptionStatus', 'done');
    fixture.detectChanges();
    expect(statusBadge()?.textContent).toContain('Done');

    fixture.componentRef.setInput('descriptionStatus', 'error');
    fixture.detectChanges();
    expect(statusBadge()?.textContent).toContain('Error');
  });

  it('emits descriptionRegenerate on the regenerate button and descriptionCommitted on commit', () => {
    const fixture = render();
    const regenerated: void[] = [];
    const committed: string[] = [];
    fixture.componentInstance.descriptionRegenerate.subscribe(() => regenerated.push(undefined));
    fixture.componentInstance.descriptionCommitted.subscribe((v) => committed.push(v));

    fixture.nativeElement.querySelector('.mui-description-field mui-button button').click();
    fixture.detectChanges();
    expect(regenerated.length).toBe(1);

    fixture.nativeElement.querySelector('.mui-description-field .display').click();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector(
      '.mui-description-field input.control',
    );
    input.value = 'A climber reaching the summit at dawn.';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(committed).toEqual(['A climber reaching the summit at dawn.']);
  });

  it('renders faces and vision chips from the given data', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.mui-faces-row').textContent).toContain('Jordan');
    expect(fixture.nativeElement.querySelector('.mui-faces-row').textContent).toContain('1 person');
    expect(fixture.nativeElement.querySelector('.mui-vision-row').textContent).toContain(
      'Mountain',
    );
  });

  it('renders the place row and emits placeCommitted / placeCleared', () => {
    const fixture = render();
    fixture.componentRef.setInput('place', 'Yosemite Valley');
    fixture.componentRef.setInput('placeOverridden', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-place-row').textContent).toContain(
      'Yosemite Valley',
    );

    const cleared: void[] = [];
    fixture.componentInstance.placeCleared.subscribe(() => cleared.push(undefined));
    fixture.nativeElement.querySelector('.mui-place-row mui-button button').click();
    fixture.detectChanges();
    expect(cleared.length).toBe(1);
  });

  it('only renders the transcript block when entries and a base time are both provided', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-transcript-block')).toBeNull();

    fixture.componentRef.setInput('transcriptEntries', [
      { id: 't1', offsetMs: 0, text: 'Hello there.' },
    ]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-transcript-block')).toBeNull();

    fixture.componentRef.setInput('transcriptBase', 1_700_000_000_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-transcript-block')).toBeTruthy();
  });
});
