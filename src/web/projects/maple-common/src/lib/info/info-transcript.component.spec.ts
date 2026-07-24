// InfoTranscriptComponent — spec.
//
// The component is a pure presentation of `detail().transcript`: it
// renders a scrollable text block + `language · model` footer when a
// transcript is present, and renders nothing otherwise. Only the fields
// the template reads are stubbed.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { InfoTranscriptComponent } from './info-transcript.component';
import type { ApiAssetDetail, ApiTranscript } from '../api/bun-api-backend.service';

function detailWith(transcript: ApiTranscript | null): ApiAssetDetail {
  return { transcript } as ApiAssetDetail;
}

function render(detail: ApiAssetDetail): HTMLElement {
  const fixture = TestBed.createComponent(InfoTranscriptComponent);
  fixture.componentRef.setInput('detail', detail);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('InfoTranscriptComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [InfoTranscriptComponent] });
  });

  it('renders the transcript text and a language · model footer', () => {
    const el = render(
      detailWith({
        text: 'the quick brown fox',
        language: 'en',
        model: 'whisper-base',
        duration_sec: 12.3,
        generated_at: '2026-07-24T00:00:00Z',
      }),
    );
    const pre = el.querySelector('.transcript-pre');
    expect(pre?.textContent).toBe('the quick brown fox');
    expect(el.textContent).toContain('en · whisper-base');
  });

  it('drops a blank language from the footer instead of rendering an orphaned separator', () => {
    // Mirrors the Swift client's test_sections_footerDropsBlankLanguage: a
    // whisper run can return `language: ""`, and the footer must render
    // just the model name, not "· whisper-base".
    const el = render(
      detailWith({
        text: 'the quick brown fox',
        language: '',
        model: 'whisper-base',
        duration_sec: null,
        generated_at: '2026-07-24T00:00:00Z',
      }),
    );
    const footer = el.querySelector('[data-testid="transcript-footer"]');
    expect(footer?.textContent?.trim()).toBe('whisper-base');
    expect(el.textContent).not.toContain('·');
  });

  it('renders nothing when there is no transcript', () => {
    const el = render(detailWith(null));
    expect(el.querySelector('.transcript-pre')).toBeNull();
    expect(el.querySelector('maple-collapsible')).toBeNull();
  });

  it('renders nothing when the transcript text is empty', () => {
    const el = render(
      detailWith({
        text: '',
        language: 'en',
        model: 'whisper-base',
        duration_sec: null,
        generated_at: '2026-07-24T00:00:00Z',
      }),
    );
    expect(el.querySelector('.transcript-pre')).toBeNull();
  });
});
