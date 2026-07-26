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

  const expandRow = (): void => {
    (fixture.nativeElement.querySelector('.row-summary') as HTMLElement).click();
    fixture.detectChanges();
  };

  it('shows the default state and labels it as unsaved', async () => {
    const req = http.expectOne(CONFIG_URL);
    expect(req.request.method).toBe('GET');
    req.flush(config(true, 'default'));
    await tick();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="gpu-live-status"]')?.textContent).toContain('GPU');
    expect(el.querySelector('[data-testid="gpu-live-summary"]')?.textContent).toContain('Default');
    // Body controls only render once expanded.
    expect(el.querySelector('[data-testid="gpu-live-enabled"]')).toBeNull();

    expandRow();
    expect((el.querySelector('[data-testid="gpu-live-enabled"]') as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('shows the CPU-fallback state when the operator has killed the GPU path', async () => {
    http.expectOne(CONFIG_URL).flush(config(false));
    await tick();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="gpu-live-status"]')?.textContent).toContain(
      'CPU fallback',
    );
    expect(el.querySelector('[data-testid="gpu-live-summary"]')?.textContent).toContain('operator');
  });

  it('unchecking the toggle PUTs false and applies it to this tab immediately', async () => {
    http.expectOne(CONFIG_URL).flush(config(true));
    await tick();
    fixture.detectChanges();
    expandRow();

    const box = fixture.nativeElement.querySelector(
      '[data-testid="gpu-live-enabled"]',
    ) as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await tick();

    const put = http.expectOne(CONFIG_URL);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ gpu_live_render_enabled: false });
    put.flush(config(false));
    await tick();

    // The save pushes a refresh through RenderConfigService so the operator's
    // own tab does not sit on the dead path until the next poll.
    http.expectOne(CONFIG_URL).flush(config(false));
    await tick();
    fixture.detectChanges();

    expect(TestBed.inject(GpuLiveRenderGate).enabled()).toBe(false);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="gpu-live-local"]')
        ?.textContent,
    ).toContain('CPU fallback');
  });

  it('reverts the toggle and surfaces the error when the save fails', async () => {
    http.expectOne(CONFIG_URL).flush(config(true));
    await tick();
    fixture.detectChanges();
    expandRow();

    const box = fixture.nativeElement.querySelector(
      '[data-testid="gpu-live-enabled"]',
    ) as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await tick();

    http
      .expectOne(CONFIG_URL)
      .flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });
    await tick();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="gpu-live-error"]')).not.toBeNull();
    expect((el.querySelector('[data-testid="gpu-live-enabled"]') as HTMLInputElement).checked).toBe(
      true,
    );
  });
});
