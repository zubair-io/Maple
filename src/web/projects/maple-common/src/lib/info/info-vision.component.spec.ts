// InfoVisionComponent — spec.
//
// Guards the #2236 regression: the OCR "Text" section used to be nested
// inside the `@if (d.vision)` gate, so legacy rows carrying `ocr_text`
// with no vision subdoc (pre-#158 Tesseract output) rendered nothing.
//
// Also guards the prompt-v7 mixed-shape window (#2726). The re-describe
// pass takes a while to work through a library, so both shapes are live in
// the DB at once and the template has to render each correctly — in
// particular an absent `people_count` must not surface as "0 people".

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { InfoVisionComponent } from './info-vision.component';
import type { ApiAssetDetail, ApiVision } from '../api/bun-api-backend.service';

/** A minimal v7-shaped vision subdoc. Spread-and-override per test. */
const V7_VISION = {
  caption: 'A red bicycle leaning against a brick wall.',
  tags: ['bicycle', 'red', 'alleyway'],
  subjects: ['vehicle'],
  scene_type: 'outdoor',
  setting: 'alleyway',
  activity: null,
  time_of_day: 'afternoon',
  lighting: 'natural',
  weather: 'clear',
  mood: 'calm',
  colors: ['red'],
  framing: 'close-up',
  text_visible: null,
  notable_objects: ['bicycle'],
  shot_type: 'static',
  is_screenshot: false,
  people_count: 2,
} as unknown as ApiVision;

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

  describe('prompt v7 fields', () => {
    it('renders the people count, pluralised', () => {
      const many = render({ vision: V7_VISION, vision_meta: null, ocr_text: null });
      expect(many.textContent).toContain('2 people');

      const one = render({
        vision: { ...V7_VISION, people_count: 1 },
        vision_meta: null,
        ocr_text: null,
      });
      expect(one.textContent).toContain('1 person');
    });

    // The distinction that matters: a pre-v7 row has no count at all, and
    // showing "0 people" would assert something the model never said.
    it('renders no people badge when the count is absent or zero', () => {
      const { people_count: _omitted, ...preV7 } = V7_VISION as ApiVision & {
        people_count: number;
      };
      const absent = render({
        vision: preV7 as ApiVision,
        vision_meta: null,
        ocr_text: null,
      });
      expect(absent.textContent).not.toContain('people');

      const zero = render({
        vision: { ...V7_VISION, people_count: 0 },
        vision_meta: null,
        ocr_text: null,
      });
      expect(zero.textContent).not.toContain('people');
    });

    it('renders the keyword chips', () => {
      const el = render({ vision: V7_VISION, vision_meta: null, ocr_text: null });
      expect(el.textContent).toContain('Keywords');
      expect(el.textContent).toContain('alleyway');
    });

    it('omits the Keywords block entirely on a pre-v7 row', () => {
      const { tags: _omitted, ...preV7 } = V7_VISION as ApiVision & { tags: string[] };
      const el = render({ vision: preV7 as ApiVision, vision_meta: null, ocr_text: null });
      expect(el.textContent).not.toContain('Keywords');
    });

    it('falls back to the retired composition value until the row is re-described', () => {
      const { framing: _omitted, ...preV7 } = V7_VISION as ApiVision & { framing: string };
      const el = render({
        vision: { ...(preV7 as ApiVision), composition: 'wide shot' },
        vision_meta: null,
        ocr_text: null,
      });
      expect(el.textContent).toContain('wide shot');
    });
  });
});
