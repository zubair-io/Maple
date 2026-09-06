import { inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryStore } from '../../state/library-store.service';
import { SERVER_WORKSPACE_PERSISTENCE } from '../../workspace/workspace-persistence';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { BatchPreviewService } from './batch-preview.service';

describe('batch value preview reads', () => {
  let http: HttpTestingController;
  let service: BatchPreviewService;
  const xml = new XmpSerializerService().serialize({ ...defaultAdjustmentModel(), exposure: 1.75 });
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: LibraryStore,
          useValue: {
            backend: 'self-hosted',
            adjustmentModels: signal(new Map()),
            absPathFor: (id: string) => (id === 'unknown' ? undefined : `/photos/${id}`),
          },
        },
        {
          provide: SERVER_WORKSPACE_PERSISTENCE,
          useFactory: () => {
            const client = inject(HttpClient);
            return { readSidecar: (path: string) => client.get(path, { responseType: 'text' }) };
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(BatchPreviewService);
  });
  afterEach(() => http.verify());

  it('reads cold targets in bounded groups of eight using the real XMP parser', async () => {
    const pending = service.readTargets(Array.from({ length: 10 }, (_, i) => `${i}.jpg`));
    const first = http.match(() => true);
    expect(first).toHaveLength(8);
    for (const request of first) request.flush(xml);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const last = http.match(() => true);
    expect(last).toHaveLength(2);
    for (const request of last) request.flush(xml);
    expect((await pending).every((model) => model.exposure === 1.75)).toBe(true);
  });

  it('treats an absent sidecar as defaults, but reports read errors and malformed XML', async () => {
    const missing = service.readPersisted('missing.jpg');
    http.expectOne('/photos/missing.jpg').flush('', { status: 404, statusText: 'Not found' });
    expect((await missing).exposure).toBe(0);
    const invalid = service.readPersisted('invalid.jpg');
    http.expectOne('/photos/invalid.jpg').flush('<broken>');
    await expect(invalid).rejects.toThrow('not valid XML');
    const unavailable = service.readPersisted('offline.jpg');
    http.expectOne('/photos/offline.jpg').flush('', { status: 503, statusText: 'Unavailable' });
    await expect(unavailable).rejects.toThrow();
    await expect(service.readPersisted('unknown')).rejects.toThrow('Cannot resolve');
  });
});
