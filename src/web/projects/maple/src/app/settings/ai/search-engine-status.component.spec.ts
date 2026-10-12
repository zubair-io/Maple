import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL, type SearchEngineView } from '@maple-common';
import { engineStatusLine, SearchEngineStatusComponent } from './search-engine-status.component';

const URL = '/api/ai/search-engine/';

function view(status: Partial<SearchEngineView['status']> = {}): SearchEngineView {
  return {
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

describe('Search engine status', () => {
  let fixture: ComponentFixture<SearchEngineStatusComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SearchEngineStatusComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SearchEngineStatusComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('shows the explanation with the model cache directory and the status line', () => {
    http.expectOne(URL).flush(view({ phase: 'loading' }));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('First use downloads ~2.2 GB to /data/.maple/models/fastembed');
    expect(fixture.nativeElement.querySelector('[role="status"]').textContent).toContain(
      'Loading the model',
    );
    expect(fixture.nativeElement.querySelector('[role="radio"]')).toBeNull();
  });

  it('says so when the status cannot be loaded', () => {
    http.expectOne(URL).flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'Could not load',
    );
  });
});

describe('engineStatusLine', () => {
  it('describes each phase in one line', () => {
    expect(engineStatusLine(null)).toBeNull();
    expect(engineStatusLine(view({ phase: 'ready', vectors: 335112, textReady: true }))).toBe(
      `Ready — ${(335112).toLocaleString()} photos indexed.`,
    );
    expect(
      engineStatusLine(
        view({
          phase: 'ready',
          vectors: 4,
          textReady: true,
          model: 'bge-m3',
          matchedModels: ['bge-m3', 'bge-m3:latest'],
          skippedVectors: 1200,
        }),
      ),
    ).toBe(
      `Ready — 4 photos indexed with vectors tagged bge-m3 or bge-m3:latest; ${(1200).toLocaleString()} vectors from other models skipped.`,
    );
    expect(engineStatusLine(view({ phase: 'ready', vectors: 2 }))).toContain(
      'keyword index still building',
    );
    expect(
      engineStatusLine(view({ phase: 'incompatible-embedder', error: 'the embed stage uses "x"' })),
    ).toBe('Not usable: the embed stage uses "x". Searches use the keyword index.');
    expect(
      engineStatusLine(
        view({
          phase: 'empty',
          model: 'bge-m3',
          matchedModels: ['bge-m3', 'bge-m3:latest'],
        }),
      ),
    ).toContain('No search vectors tagged bge-m3 or bge-m3:latest yet');
    expect(engineStatusLine(view({ phase: 'failed', error: 'no ORT' }))).toContain(
      'Could not start: no ORT',
    );
    expect(engineStatusLine(view({ phase: 'stopped' }))).toBe('Not running.');
  });
});
