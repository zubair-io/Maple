import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { API_BASE_URL, type MeilisearchEmbedderDrift } from '@maple-common';
import { MeilisearchEmbedderDriftComponent } from './meilisearch-embedder-drift.component';

const DRIFT_URL = '/api/admin/enrichment/meilisearch-embedder';
const APPLY_URL = '/api/admin/enrichment/meilisearch-embedder/apply';

const drift: MeilisearchEmbedderDrift = {
  state: 'drift',
  configured: { url: 'http://192.168.0.201:11434/api/embed', model: 'bge-m3' },
  live: { url: 'http://192.168.0.250:11434/api/embed', model: 'bge-m3' },
  changedFields: ['url'],
  documentCount: 335_000,
  reembedsAllDocuments: true,
};

describe('MeilisearchEmbedderDriftComponent', () => {
  let fixture: ComponentFixture<MeilisearchEmbedderDriftComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MeilisearchEmbedderDriftComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MeilisearchEmbedderDriftComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const load = async (payload: MeilisearchEmbedderDrift): Promise<void> => {
    http.expectOne(DRIFT_URL).flush(payload);
    await tick();
    fixture.detectChanges();
  };

  const press = async (testId: string): Promise<void> => {
    (el().querySelector(`[data-testid="${testId}"] button`) as HTMLButtonElement).click();
    await tick();
    fixture.detectChanges();
  };

  it('shows both embedders and the re-embed cost when the index drifted', async () => {
    await load(drift);
    expect(el().hidden).toBe(false);
    const text = el().textContent ?? '';
    expect(text).toContain('http://192.168.0.250:11434/api/embed · bge-m3');
    expect(text).toContain('http://192.168.0.201:11434/api/embed · bge-m3');
    expect(
      el().querySelector('[data-testid="meilisearch-embedder-reembed-warning"]')?.textContent,
    ).toContain(`all ${(335_000).toLocaleString()} documents`);
  });

  it('applies only after the operator confirms, then rechecks', async () => {
    await load(drift);
    await press('meilisearch-embedder-apply');
    http.expectNone(APPLY_URL);

    await press('meilisearch-embedder-confirm');
    const apply = http.expectOne(APPLY_URL);
    expect(apply.request.method).toBe('POST');
    apply.flush({ taskUid: 41, reembedsAllDocuments: true, documentCount: 335_000 });
    await tick();
    await load({ ...drift, state: 'pending' });

    expect(el().querySelector('[data-testid="meilisearch-embedder-pending"]')).not.toBeNull();
  });

  it('stays hidden when the index matches Settings', async () => {
    await load({ ...drift, state: 'in_sync', live: drift.configured, changedFields: [] });
    expect(el().hidden).toBe(true);
  });

  it('stays hidden for a member who may not read admin index state', async () => {
    http
      .expectOne(DRIFT_URL)
      .flush({ error: 'forbidden' }, { status: 403, statusText: 'Forbidden' });
    await tick();
    fixture.detectChanges();
    expect(el().hidden).toBe(true);
  });
});
