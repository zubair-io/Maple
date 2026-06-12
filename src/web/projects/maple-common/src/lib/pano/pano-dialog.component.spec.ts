import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PanoDialogComponent } from './pano-dialog.component';
import { API_BASE_URL } from '../api/api-base-url.token';
import { LibraryStateService } from '../state/library-state.service';
import type { PanoConfig } from '../api/pano.service';

const CONFIG = (strategySupported: boolean): PanoConfig => ({
  maple_cli_path: '/opt/maple-cli',
  models_dir: '/models',
  ort_dylib_path: null,
  enabled: true,
  strategy_supported: strategySupported,
  source: {
    maple_cli_path: 'db',
    models_dir: 'db',
    ort_dylib_path: 'unset',
    enabled: 'db',
  },
});

describe('PanoDialogComponent', () => {
  let fixture: ComponentFixture<PanoDialogComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PanoDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
        {
          provide: LibraryStateService,
          useValue: { selectedSourceId: () => 'fs:lib1' },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PanoDialogComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.componentRef.setInput('assetIds', ['a1', 'a2', 'a3']);
  });

  afterEach(() => http.verify());

  function open(strategySupported: boolean): void {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    http.expectOne('/api/pano/config').flush(CONFIG(strategySupported));
    fixture.detectChanges();
  }

  it('loads config on open and reaches the options phase', () => {
    open(false);
    expect(fixture.componentInstance.phase()).toBe('options');
    expect(fixture.componentInstance.strategySupported()).toBe(false);
  });

  it('hides the strategy control when the binary does not support it', () => {
    open(false);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('#pano-strategy')).toBeNull();
  });

  it('shows the strategy control when supported', () => {
    open(true);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('#pano-strategy')).not.toBeNull();
  });

  it('submits without a strategy field when unsupported', () => {
    open(false);
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body).toEqual({
      assetIds: ['a1', 'a2', 'a3'],
      libraryId: 'lib1',
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    call.flush({ id: 'j1' }, { status: 201, statusText: 'Created' });
    expect(fixture.componentInstance.phase()).toBe('polling');
    // Silence the first poll tick if it fires synchronously in teardown.
    fixture.componentInstance.onCancel();
  });

  it('includes the chosen strategy when supported', () => {
    open(true);
    fixture.componentInstance.strategy.set('tile');
    fixture.componentInstance.onSubmit();
    const call = http.expectOne('/api/pano/stitch');
    expect(call.request.body).toEqual({
      assetIds: ['a1', 'a2', 'a3'],
      libraryId: 'lib1',
      options: { retention: 'keep', localAlign: 'mesh', strategy: 'tile' },
    });
    call.flush({ id: 'j2' }, { status: 201, statusText: 'Created' });
    fixture.componentInstance.onCancel();
  });

  it('renders the provisioning message on 409 pano_not_provisioned', () => {
    open(false);
    fixture.componentInstance.onSubmit();
    http
      .expectOne('/api/pano/stitch')
      .flush(
        { error: 'pano_not_provisioned', message: 'Set the maple-cli path in Settings > Pano.' },
        { status: 409, statusText: 'Conflict' },
      );
    expect(fixture.componentInstance.phase()).toBe('error');
    expect(fixture.componentInstance.errorMessage()).toContain('Settings > Pano');
  });
});
