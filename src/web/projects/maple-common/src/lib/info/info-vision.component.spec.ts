// InfoVisionComponent — spec.
//
// Guards the #2236 regression: the OCR "Text" section used to be nested
// inside the `@if (d.vision)` gate, so legacy rows carrying `ocr_text`
// with no vision subdoc (pre-#158 Tesseract output) rendered nothing.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { InfoVisionComponent } from './info-vision.component';
import type { ApiAssetDetail } from '../api/bun-api-backend.service';

function render(detail: Partial<ApiAssetDetail>): HTMLElement {
  const fixture = TestBed.createComponent(InfoVisionComponent);
  fixture.componentRef.setInput('detail', detail as ApiAssetDetail);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('InfoVisionComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [InfoVisionComponent] });
  });

  it('renders OCR text even when there is no vision subdoc (legacy Tesseract rows)', () => {
    const el = render({ vision: null, vision_meta: null, ocr_text: 'OPEN 24 HOURS' });
    const pre = el.querySelector('.ocr-pre');
    expect(pre?.textContent).toBe('OPEN 24 HOURS');
  });

  it('renders nothing when there is neither vision nor ocr_text', () => {
    const el = render({ vision: null, vision_meta: null, ocr_text: null });
    expect(el.querySelector('.ocr-pre')).toBeNull();
    expect(el.querySelector('maple-collapsible')).toBeNull();
  });

  it('does not render an empty OCR block for empty-string ocr_text', () => {
    // The describe stage writes `''` (not null) when the model saw no text.
    const el = render({ vision: null, vision_meta: null, ocr_text: '' });
    expect(el.querySelector('.ocr-pre')).toBeNull();
  });
});
