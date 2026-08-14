import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { API_BASE_URL, type MapConfig } from '@maple-common';
import { MapSettingsComponent } from './map-settings.component';

const CONFIG: MapConfig = {
  tile_url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  source: { tile_url: 'default' },
};

describe('MapSettingsComponent', () => {
  let fixture: ComponentFixture<MapSettingsComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MapSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MapSettingsComponent);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function load(config: MapConfig = CONFIG): Promise<void> {
    fixture.detectChanges(); // ngOnInit → GET config
    http.expectOne('/api/map/config').flush(config);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function input(sel: string): HTMLInputElement {
    const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(sel);
    if (!el) throw new Error(`missing element ${sel}`);
    return el;
  }

  it('seeds the form from the loaded config', async () => {
    await load();
    expect(input('#map-tile-url').value).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  });

  it('saves an edited tile URL as a PUT patch and reflects the saved value', async () => {
    await load();
    const url = input('#map-tile-url');
    url.value = 'https://tiles.example.com/{z}/{x}/{y}.png';
    url.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    const form = (fixture.nativeElement as HTMLElement).querySelector('form');
    form?.dispatchEvent(new Event('submit'));

    const call = http.expectOne('/api/map/config');
    expect(call.request.method).toBe('PUT');
    expect(call.request.body).toEqual({ tile_url: 'https://tiles.example.com/{z}/{x}/{y}.png' });
    call.flush({
      tile_url: 'https://tiles.example.com/{z}/{x}/{y}.png',
      source: { tile_url: 'db' },
      ok: true,
    });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Saved.');
  });

  it('shows a clear error when the server rejects a malformed URL', async () => {
    await load();
    const url = input('#map-tile-url');
    url.value = 'not a url';
    url.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    const form = (fixture.nativeElement as HTMLElement).querySelector('form');
    form?.dispatchEvent(new Event('submit'));

    const call = http.expectOne('/api/map/config');
    call.flush(
      { error: 'Invalid tile_url: Not a valid URL' },
      { status: 400, statusText: 'Bad Request' },
    );
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Not a valid URL');
  });

  it('shows the load error state when the config fetch fails', () => {
    fixture.detectChanges();
    http
      .expectOne('/api/map/config')
      .flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('boom');
  });
});
