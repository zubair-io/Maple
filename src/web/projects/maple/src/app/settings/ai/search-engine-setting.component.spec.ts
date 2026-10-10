import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL, type SearchEngineView } from '@maple-common';
import { engineStatusLine, SearchEngineSettingComponent } from './search-engine-setting.component';

const URL = '/api/ai/search-engine/';

function view(
  engine: SearchEngineView['engine'],
  status: Partial<SearchEngineView['status']> = {},
): SearchEngineView {
  return {
    engine,
    status: {
      phase: 'stopped',
      vectors: 0,
      texts: 0,
      textReady: false,
      restarts: 0,
      ...status,
    },
    modelCacheDir: '/data/.maple/models/fastembed',
  };
}

describe('Search engine setting', () => {
  let fixture: ComponentFixture<SearchEngineSettingComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SearchEngineSettingComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SearchEngineSettingComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne(URL).flush(view('meilisearch'));
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  function segment(label: string): HTMLButtonElement {
    const segments = [
      ...fixture.nativeElement.querySelectorAll('[role="radio"]'),
    ] as HTMLButtonElement[];
    return segments.find((button) => button.textContent?.trim() === label)!;
  }

  it('shows the saved engine as the selected segment with the explanation', () => {
    const group = fixture.nativeElement.querySelector('[aria-label="Search engine"]');
    expect(group).not.toBeNull();
    expect(segment('Meilisearch').getAttribute('aria-checked')).toBe('true');
    expect(fixture.nativeElement.textContent).toContain('falls back to Meilisearch');
    expect(fixture.nativeElement.textContent).toContain(
      'First use downloads ~2.2 GB to /data/.maple/models/fastembed',
    );
    expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
  });

  it('saves a new engine at once and shows how far it has loaded', () => {
    segment('In-process').click();
    const request = http.expectOne(URL);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ engine: 'in-process' });
    request.flush(view('in-process', { phase: 'loading' }));
    fixture.detectChanges();

    expect(segment('In-process').getAttribute('aria-checked')).toBe('true');
    expect(fixture.nativeElement.querySelector('[role="status"]').textContent).toContain(
      'Loading the model',
    );
  });

  it('keeps the previous engine and says so when the save fails', () => {
    segment('In-process').click();
    fixture.detectChanges();
    http.expectOne(URL).flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect(segment('Meilisearch').getAttribute('aria-checked')).toBe('true');
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'Could not switch',
    );
  });

  it('describes each in-process phase in one line', () => {
    expect(engineStatusLine(view('meilisearch', { phase: 'ready' }))).toBeNull();
    expect(
      engineStatusLine(view('in-process', { phase: 'ready', vectors: 335112, textReady: true })),
    ).toBe(`Ready — ${(335112).toLocaleString()} photos indexed.`);
    expect(
      engineStatusLine(
        view('in-process', {
          phase: 'ready',
          vectors: 4,
          textReady: true,
          model: 'bge-m3',
          skippedVectors: 1200,
        }),
      ),
    ).toBe(
      `Ready — 4 photos indexed with bge-m3; ${(1200).toLocaleString()} vectors from other models skipped.`,
    );
    expect(engineStatusLine(view('in-process', { phase: 'ready', vectors: 2 }))).toContain(
      'keyword index still building',
    );
    expect(engineStatusLine(view('in-process', { phase: 'failed', error: 'no ORT' }))).toContain(
      'Could not start: no ORT',
    );
  });
});
