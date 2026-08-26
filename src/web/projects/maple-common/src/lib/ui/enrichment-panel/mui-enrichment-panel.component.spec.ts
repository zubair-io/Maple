import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { MuiEnrichmentPanelComponent } from './mui-enrichment-panel.component';
import type { MuiEnrichmentStageStatus } from './mui-enrichment-panel.component';

function render(): ComponentFixture<MuiEnrichmentPanelComponent> {
  TestBed.configureTestingModule({
    imports: [MuiEnrichmentPanelComponent],
    providers: [provideRouter([])],
  });
  const fixture = TestBed.createComponent(MuiEnrichmentPanelComponent);
  fixture.componentRef.setInput('description', 'A hiker crossing a ridge at sunset.');
  fixture.componentRef.setInput('people', [{ id: 'p1', label: 'Jordan' }]);
  fixture.componentRef.setInput('visionLabels', [{ id: 'v1', label: 'Mountain' }]);
  // Required (no built-in default — see the input's doc comment: a literal
  // default here would bake a Self-Hosted-only route into every consumer,
  // including this design system's own Hosted showcase).
  fixture.componentRef.setInput('workersSettingsHref', '/test/workers');
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

  describe('per-stage status (#3030 MW3 extension)', () => {
    const FAILED: MuiEnrichmentStageStatus = { kind: 'failed', label: 'Failed', tooltip: 'boom' };
    const PAUSED: MuiEnrichmentStageStatus = { kind: 'paused', label: 'Worker paused' };
    const COMPLETE: MuiEnrichmentStageStatus = { kind: 'complete', label: '' };

    it('descriptionStageStatus takes precedence over the simple descriptionStatus badge', () => {
      const fixture = render();
      fixture.componentRef.setInput('descriptionStatus', 'done');
      fixture.componentRef.setInput('descriptionStageStatus', FAILED);
      fixture.detectChanges();
      const badge = fixture.nativeElement.querySelector('.description-group mui-badge');
      expect(badge?.textContent).toContain('Failed');
      expect(badge?.textContent).not.toContain('Done');
    });

    it('renders a paused stage as a router-link badge to the caller-supplied workersSettingsHref', () => {
      const fixture = render();
      fixture.componentRef.setInput('faceStatus', PAUSED);
      fixture.detectChanges();
      const link = fixture.nativeElement.querySelector('.faces-group a.stage-badge--paused');
      expect(link?.textContent).toContain('Worker paused');
      expect(link?.getAttribute('href')).toBe('/test/workers');
    });

    it('renders no badge for a complete stage (empty label)', () => {
      const fixture = render();
      fixture.componentRef.setInput('placeStatus', COMPLETE);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.place-group mui-badge')).toBeNull();
      expect(fixture.nativeElement.querySelector('.place-group a.stage-badge--paused')).toBeNull();
    });

    it('shows the per-stage error message, or the stale hint when there is no error', () => {
      const fixture = render();
      fixture.componentRef.setInput('faceError', 'Failed to requeue — try again.');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.faces-group').textContent).toContain(
        'Failed to requeue',
      );

      fixture.componentRef.setInput('faceError', null);
      fixture.componentRef.setInput('faceStale', true);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.faces-group').textContent).toContain(
        'Still pending',
      );
    });

    it('emits placeRequeue on the Re-geocode button', () => {
      const fixture = render();
      let count = 0;
      fixture.componentInstance.placeRequeue.subscribe(() => count++);
      const buttons = fixture.nativeElement.querySelectorAll('.place-group mui-button button');
      (buttons[buttons.length - 1] as HTMLButtonElement).click();
      expect(count).toBe(1);
    });

    it('passes facesTotalCount/facesUntaggedCount through to mui-faces-row', () => {
      const fixture = render();
      fixture.componentRef.setInput('facesTotalCount', 7);
      fixture.componentRef.setInput('facesUntaggedCount', 4);
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('.mui-faces-row');
      expect(el.textContent).toContain('7 faces detected');
      expect(el.textContent).toContain('4 unnamed');
    });

    it('emits facesUntaggedClicked through to the untagged pill', () => {
      const fixture = render();
      fixture.componentRef.setInput('facesUntaggedCount', 2);
      fixture.detectChanges();
      let count = 0;
      fixture.componentInstance.facesUntaggedClicked.subscribe(() => count++);
      (fixture.nativeElement.querySelector('.untagged') as HTMLButtonElement).click();
      expect(count).toBe(1);
    });
  });
});
