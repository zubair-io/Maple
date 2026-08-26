import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { API_BASE_URL, type PanoConfig } from '@maple-common';
import { PanoSettingsComponent } from './pano-settings.component';

const CONFIG: PanoConfig = {
  maple_cli_path: '/opt/bin/maple-cli',
  models_dir: '/var/models',
  ort_dylib_path: null,
  enabled: false,
  strategy_supported: false,
  source: {
    maple_cli_path: 'db',
    models_dir: 'db',
    ort_dylib_path: 'unset',
    enabled: 'db',
  },
};

describe('PanoSettingsComponent', () => {
  let fixture: ComponentFixture<PanoSettingsComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PanoSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PanoSettingsComponent);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function load(): Promise<void> {
    fixture.detectChanges(); // ngOnInit → GET config
    http.expectOne('/api/pano/config').flush(CONFIG);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function inputByLabel(ariaLabel: string): HTMLInputElement {
    const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      `mui-input input[aria-label="${ariaLabel}"]`,
    );
    if (!el) throw new Error(`missing input labeled ${ariaLabel}`);
    return el;
  }

  function enabledCheckbox(): HTMLInputElement {
    const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'mui-checkbox input[type="checkbox"]',
    );
    if (!el) throw new Error('missing enabled checkbox');
    return el;
  }

  function clickSave(): void {
    const btn = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'mui-button button',
    );
    if (!btn) throw new Error('missing save button');
    btn.click();
  }

  it('seeds the form from the loaded config', async () => {
    await load();
    expect(inputByLabel('maple-cli binary path').value).toBe('/opt/bin/maple-cli');
    expect(inputByLabel('Models directory (MAPLE_PANO_MODELS)').value).toBe('/var/models');
    expect(inputByLabel('ONNX Runtime dylib (ORT_DYLIB_PATH)').value).toBe('');
    expect(enabledCheckbox().checked).toBe(false);
  });

  it('saves the edited form as a PUT patch with empty strings as null', async () => {
    await load();
    const cli = inputByLabel('maple-cli binary path');
    cli.value = '/usr/local/bin/maple-cli';
    cli.dispatchEvent(new Event('input'));
    const models = inputByLabel('Models directory (MAPLE_PANO_MODELS)');
    models.value = '   ';
    models.dispatchEvent(new Event('input'));
    const enabled = enabledCheckbox();
    enabled.click();
    fixture.detectChanges();
    await fixture.whenStable();

    clickSave();

    const call = http.expectOne('/api/pano/config');
    expect(call.request.method).toBe('PUT');
    expect(call.request.body).toEqual({
      enabled: true,
      maple_cli_path: '/usr/local/bin/maple-cli',
      models_dir: null,
      ort_dylib_path: null,
    });
    call.flush({ ...CONFIG, enabled: true, maple_cli_path: '/usr/local/bin/maple-cli', ok: true });
  });

  it('shows the load error state when the config fetch fails', () => {
    fixture.detectChanges();
    http
      .expectOne('/api/pano/config')
      .flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('boom');
  });
});
