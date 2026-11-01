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
  matcher: 'ml',
  strategy_supported: false,
  features_engine_supported: true,
  preview_supported: false,
  edges_supported: false,
  source: {
    maple_cli_path: 'db',
    models_dir: 'db',
    ort_dylib_path: 'unset',
    enabled: 'db',
    matcher: 'db',
  },
};

const CLASSICAL_DEFAULT: PanoConfig = {
  ...CONFIG,
  models_dir: null,
  matcher: 'classical',
  source: { ...CONFIG.source, models_dir: 'unset', matcher: 'default' },
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

  async function load(config: PanoConfig = CONFIG): Promise<void> {
    fixture.detectChanges(); // ngOnInit → GET config
    http.expectOne('/api/pano/config').flush(config);
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

  function hasInput(ariaLabel: string): boolean {
    return (
      (fixture.nativeElement as HTMLElement).querySelector(
        `mui-input input[aria-label="${ariaLabel}"]`,
      ) !== null
    );
  }

  function matcherSegment(label: string): HTMLButtonElement {
    const segments = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      'mui-segmented-toggle button[role="radio"]',
    );
    const match = [...segments].find((b) => b.textContent?.trim() === label);
    if (!match) throw new Error(`missing matcher segment ${label}`);
    return match;
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
      matcher: 'ml',
      maple_cli_path: '/usr/local/bin/maple-cli',
      models_dir: null,
      ort_dylib_path: null,
    });
    call.flush({ ...CONFIG, enabled: true, maple_cli_path: '/usr/local/bin/maple-cli', ok: true });
  });

  it('defaults to the classical matcher and hides the ML-only path fields (#4555)', async () => {
    await load(CLASSICAL_DEFAULT);
    expect(matcherSegment('Classical').getAttribute('aria-checked')).toBe('true');
    expect(hasInput('Models directory (MAPLE_PANO_MODELS)')).toBe(false);
    expect(hasInput('ONNX Runtime dylib (ORT_DYLIB_PATH)')).toBe(false);
  });

  it('reveals the ML path fields and saves the matcher when ML is chosen (#4555)', async () => {
    await load(CLASSICAL_DEFAULT);
    matcherSegment('ML').click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(hasInput('Models directory (MAPLE_PANO_MODELS)')).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'needs both the models directory and the ONNX Runtime path',
    );

    clickSave();

    const call = http.expectOne('/api/pano/config');
    expect(call.request.body).toMatchObject({ matcher: 'ml' });
    call.flush({ ...CLASSICAL_DEFAULT, matcher: 'ml', ok: true });
  });

  it('warns that a binary without --features-engine must be rebuilt (#4555)', async () => {
    await load({ ...CLASSICAL_DEFAULT, features_engine_supported: false });
    const banner = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="pano-cli-outdated"]',
    );
    expect(banner?.textContent).toContain('--features pano,pano-classical');
  });

  it('seeds ML paths resolved from the legacy environment variables and labels them (#4555)', async () => {
    await load({
      ...CONFIG,
      models_dir: '/env/models',
      ort_dylib_path: '/env/libonnxruntime.so',
      source: { ...CONFIG.source, models_dir: 'env', ort_dylib_path: 'env' },
    });
    const text = (fixture.nativeElement as HTMLElement).textContent;
    expect(text).not.toContain('needs both the models directory and the ONNX Runtime path');
    expect(text).toContain('environment variable (deprecated)');
  });

  it('keeps the bundled maple-cli by leaving the path blank (#5493)', async () => {
    await load({
      ...CLASSICAL_DEFAULT,
      maple_cli_path: '/app/native/maple-cli',
      enabled: true,
      source: { ...CLASSICAL_DEFAULT.source, maple_cli_path: 'bundled', enabled: 'default' },
    });
    const cli = inputByLabel('maple-cli binary path');
    expect(cli.value).toBe('');
    expect(cli.placeholder).toBe('/app/native/maple-cli');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'bundled with this server',
    );

    clickSave();
    const call = http.expectOne('/api/pano/config');
    expect(call.request.body.maple_cli_path).toBeNull();
    expect(call.request.body.enabled).toBeNull();
    call.flush({ ...CLASSICAL_DEFAULT, ok: true });
  });

  it('keeps stitching on when a custom path replaces the bundled binary (#5493)', async () => {
    await load({
      ...CLASSICAL_DEFAULT,
      maple_cli_path: '/app/native/maple-cli',
      enabled: true,
      source: { ...CLASSICAL_DEFAULT.source, maple_cli_path: 'bundled', enabled: 'default' },
    });
    const cli = inputByLabel('maple-cli binary path');
    cli.value = '/opt/custom/maple-cli';
    cli.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    clickSave();
    const call = http.expectOne('/api/pano/config');
    expect(call.request.body).toMatchObject({
      maple_cli_path: '/opt/custom/maple-cli',
      enabled: true,
    });
    call.flush({ ...CLASSICAL_DEFAULT, ok: true });
  });

  it('saves an explicit off when the default-on toggle is turned off (#5493)', async () => {
    await load({
      ...CLASSICAL_DEFAULT,
      maple_cli_path: '/app/native/maple-cli',
      enabled: true,
      source: { ...CLASSICAL_DEFAULT.source, maple_cli_path: 'bundled', enabled: 'default' },
    });
    enabledCheckbox().click();
    fixture.detectChanges();
    await fixture.whenStable();

    clickSave();
    const call = http.expectOne('/api/pano/config');
    expect(call.request.body.enabled).toBe(false);
    call.flush({ ...CLASSICAL_DEFAULT, ok: true });
  });

  it('shows the load error state when the config fetch fails', () => {
    fixture.detectChanges();
    http
      .expectOne('/api/pano/config')
      .flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('boom');
  });

  it("shows the server's rejection reason when a save is refused (#5517)", async () => {
    await load();
    clickSave();
    const reason =
      'maple_cli_path must not point inside a library root (/photos); the server executes it';
    http
      .expectOne((r) => r.method === 'PUT' && r.url === '/api/pano/config')
      .flush({ error: reason }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain(reason);
    expect(text).not.toContain('Save failed.');
  });

  it('shows the owner-gate rejection rather than a generic failure (#5517)', async () => {
    await load();
    clickSave();
    http
      .expectOne((r) => r.method === 'PUT' && r.url === '/api/pano/config')
      .flush({ error: 'owner role required' }, { status: 403, statusText: 'Forbidden' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('owner role required');
  });

  it('shows the load error from the API error field (#5517)', () => {
    fixture.detectChanges();
    http
      .expectOne('/api/pano/config')
      .flush({ error: 'unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('unauthorized');
  });
});
