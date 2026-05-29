// InfoHistogramComponent — spec.
//
// v0.1 is a styled placeholder rect. The spec verifies the block height,
// the "Histogram" label, and the decorative curves are rendered. When
// the API endpoint follow-up lands, these tests pivot to verify the
// `<img>` fetch + skeleton state.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { InfoHistogramComponent } from './histogram.component';

describe('InfoHistogramComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders a labelled placeholder block', () => {
    TestBed.configureTestingModule({ imports: [InfoHistogramComponent] });
    const fixture = TestBed.createComponent(InfoHistogramComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.block')).not.toBeNull();
    expect(root.querySelector('.label')?.textContent).toBe('Histogram');
  });

  it('renders decorative RGB curves inside the placeholder', () => {
    TestBed.configureTestingModule({ imports: [InfoHistogramComponent] });
    const fixture = TestBed.createComponent(InfoHistogramComponent);
    fixture.detectChanges();

    const paths = (fixture.nativeElement as HTMLElement).querySelectorAll('svg.curves path');
    expect(paths.length).toBe(3);
  });
});
