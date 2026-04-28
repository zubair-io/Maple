import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { IndexerAdminComponent } from './indexer-admin.component';
import { API_BASE_URL } from '../../api/api-base-url.token';

const STATUS_RUNNING = {
  paused: false,
  pools: { discover: 4, hash: 2, exif: 4, thumb: 2, ai: 1, mongo: 8 },
  channels: {
    discover: { depth: 0, capacity: 256 }, hash: { depth: 1, capacity: 256 },
    exif: { depth: 0, capacity: 256 }, thumb: { depth: 3, capacity: 128 },
    ai: { depth: 0, capacity: 256 }, mongo: { depth: 0, capacity: 256 },
  },
  stages: {
    discover: { inFlight: 0, errors: 0, deadLetter: 0 },
    hash: { inFlight: 1, errors: 0, deadLetter: 0 },
    exif: { inFlight: 0, errors: 0, deadLetter: 0 },
    thumb: { inFlight: 2, errors: 0, deadLetter: 0 },
    ai: { inFlight: 0, errors: 0, deadLetter: 0 },
    mongo: { inFlight: 0, errors: 0, deadLetter: 0 },
  },
};

describe('IndexerAdminComponent', () => {
  let fixture: ComponentFixture<IndexerAdminComponent>;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [IndexerAdminComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    fixture = TestBed.createComponent(IndexerAdminComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => {
    // Destroy before verify so the polling interval unsubscribes first.
    fixture.destroy();
    http.verify();
  });

  it('fetches status on init and renders the stages table', () => {
    http.expectOne((r) => r.url === '/api/indexer/status').flush(STATUS_RUNNING);
    http.expectOne((r) => r.url === '/api/indexer/dead-letter').flush({ items: [], total: 0 });
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.stages tbody tr');
    expect(rows.length).toBe(6);
    expect(fixture.nativeElement.querySelector('.pause-btn').textContent).toContain('Pause');
  });

  it('togglePause posts /pause when running', () => {
    http.expectOne('/api/indexer/status').flush(STATUS_RUNNING);
    http.expectOne((r) => r.url === '/api/indexer/dead-letter').flush({ items: [], total: 0 });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.pause-btn') as HTMLButtonElement).click();
    const post = http.expectOne((r) => r.method === 'POST' && r.url === '/api/indexer/pause');
    post.flush({ ok: true, status: { ...STATUS_RUNNING, paused: true } });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pause-btn').textContent).toContain('Resume');
  });

  it('setPool PUTs /config when slider changes', () => {
    http.expectOne('/api/indexer/status').flush(STATUS_RUNNING);
    http.expectOne((r) => r.url === '/api/indexer/dead-letter').flush({ items: [], total: 0 });
    fixture.detectChanges();

    fixture.componentInstance.setPool('thumb', 6);
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/indexer/config');
    expect(put.request.body).toEqual({ workers: { thumb: 6 } });
    put.flush({ ok: true, status: { ...STATUS_RUNNING, pools: { ...STATUS_RUNNING.pools, thumb: 6 } } });
  });
});
