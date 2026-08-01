import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FsAccessLibrarySource } from '../addressing/fs-access-library-source';
import { HttpLibrarySource } from '../addressing/http-library-source';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { provideHostedWorkspace } from './hosted-workspace.providers';
import { provideSelfHostedWorkspace } from './self-hosted-workspace.providers';
import { WORKSPACE_CAPABILITIES } from './workspace-capabilities';
import { SERVER_WORKSPACE_PERSISTENCE } from './workspace-persistence';

describe('workspace providers', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('wires Hosted only to browser filesystem services', () => {
    const fsSource = {};
    TestBed.configureTestingModule({
      providers: [provideHostedWorkspace(), { provide: FsAccessLibrarySource, useValue: fsSource }],
    });

    expect(TestBed.inject(LIBRARY_BACKEND)).toBe('hosted');
    expect(TestBed.inject(LIBRARY_SOURCE)).toBe(fsSource);
    expect(TestBed.inject(SERVER_WORKSPACE_PERSISTENCE)).toBeNull();
    expect(TestBed.inject(WORKSPACE_CAPABILITIES).resolve('single-file').mode).toBe(
      'hosted-single-file',
    );
  });

  it('adapts Self Hosted HTTP persistence behind the narrow port', async () => {
    const httpSource = {};
    const api = {
      getXmp: vi.fn(() => of('<xmp/>')),
      putXmp: vi.fn(() => of(undefined)),
      putPreview: vi.fn(() => of(undefined)),
    };
    TestBed.configureTestingModule({
      providers: [
        provideSelfHostedWorkspace(),
        { provide: HttpLibrarySource, useValue: httpSource },
        { provide: BunApiBackendService, useValue: api },
      ],
    });

    const persistence = TestBed.inject(SERVER_WORKSPACE_PERSISTENCE)!;
    expect(TestBed.inject(LIBRARY_SOURCE)).toBe(httpSource);
    expect(TestBed.inject(WORKSPACE_CAPABILITIES).resolve('single-file').mode).toBe('self-hosted');
    await expect(firstValueFrom(persistence.readSidecar('/photos/a.raw'))).resolves.toBe('<xmp/>');
    await firstValueFrom(persistence.writeSidecar('/photos/a.raw', '<xmp/>'));
    await firstValueFrom(persistence.writePreview('/photos/a.raw', new Blob(), 'image/avif'));
    expect(api.putXmp).toHaveBeenCalledWith('/photos/a.raw', '<xmp/>');
    expect(api.putPreview).toHaveBeenCalledWith('/photos/a.raw', expect.any(Blob), 'image/avif');
  });
});
