import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  API_BASE_URL,
  GpuLiveRenderGate,
  STORAGE_KEYS,
  TypedStorage,
  type RenderConfigResponse,
} from '@maple-common';
import { GpuLiveRenderSettingsComponent } from './gpu-live-render-settings.component';

const CONFIG_URL = '/api/render/config';

function config(enabled: boolean, source: 'db' | 'default' = 'db'): RenderConfigResponse {
  return { gpu_live_render_enabled: enabled, source: { gpu_live_render_enabled: source } };
}

describe('GpuLiveRenderSettingsComponent (#1062)', () => {
  let fixture: ComponentFixture<GpuLiveRenderSettingsComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    TypedStorage.remove(STORAGE_KEYS.GPU_LIVE_RENDER_ENABLED);
    await TestBed.configureTestingModule({
      imports: [GpuLiveRenderSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(GpuLiveRenderSettingsComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const box = (): HTMLInputElement =>
    el().querySelector('[data-testid="gpu-live-enabled"]') as HTMLInputElement;

  /** Expand the row, which refreshes the config from the API. */
  const expandRow = async (respond: RenderConfigResponse): Promise<void> => {
    (el().querySelector('.row-summary') as HTMLElement).click();
    fixture.detectChanges();
    http.expectOne(CONFIG_URL).flush(respond);
    await tick();
    fixture.detectChanges();
  };

  it('does not fetch on init — the shared config service owns the read path', () => {
    // The panel renders from RenderConfigService's signal, which the app
    // initializer has already populated in a live app.
    http.expectNone(CONFIG_URL);
    expect(el().querySelector('[data-testid="gpu-live-summary"]')?.textContent).toContain(
      'Not loaded',
    );
    // With nothing fetched it still shows the gate's effective state, so the
    // operator can throw the switch even when the API was unreachable.
    expect(el().querySelector('[data-testid="gpu-live-status"]')?.textContent).toContain('GPU');
  });

  it('refreshes on expand and labels an unsaved value as the default', async () => {
    await expandRow(config(true, 'default'));
    expect(el().querySelector('[data-testid="gpu-live-summary"]')?.textContent).toContain(
      'Default',
    );
    expect(box().checked).toBe(true);
  });

  it('shows the CPU-fallback state when the operator has killed the GPU path', async () => {
    await expandRow(config(false));
    expect(el().querySelector('[data-testid="gpu-live-status"]')?.textContent).toContain(
      'CPU fallback',
    );
    expect(el().querySelector('[data-testid="gpu-live-summary"]')?.textContent).toContain(
      'operator',
    );
    expect(box().checked).toBe(false);
  });

  it('unchecking the toggle PUTs false and applies it to this tab immediately', async () => {
    await expandRow(config(true));
    expect(TestBed.inject(GpuLiveRenderGate).enabled()).toBe(true);

    box().checked = false;
    box().dispatchEvent(new Event('change'));
    await tick();

    const put = http.expectOne(CONFIG_URL);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ gpu_live_render_enabled: false });
    put.flush(config(false));
    await tick();

    // The save pushes a refresh through RenderConfigService, so the gate this
    // tab's editor reads is already off — no waiting for the next poll.
    http.expectOne(CONFIG_URL).flush(config(false));
    await tick();
    fixture.detectChanges();

    expect(TestBed.inject(GpuLiveRenderGate).enabled()).toBe(false);
    expect(el().querySelector('[data-testid="gpu-live-local"]')?.textContent).toContain(
      'CPU fallback',
    );
  });

  it('snaps the checkbox back and surfaces the error when the save fails', async () => {
    await expandRow(config(true));

    box().checked = false;
    box().dispatchEvent(new Event('change'));
    await tick();

    http
      .expectOne(CONFIG_URL)
      .flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });
    await tick();
    fixture.detectChanges();

    expect(el().querySelector('[data-testid="gpu-live-error"]')).not.toBeNull();
    expect(box().checked).toBe(true);
    expect(TestBed.inject(GpuLiveRenderGate).enabled()).toBe(true);
  });
});
