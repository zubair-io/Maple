// FilesystemBrowseService after the #1325 web cutover: the absolute-path
// thumbnail surface the search / timeline / map / people grids still key on
// resolves through the registered libraries to a `slug:relPath` address and
// fetches `/api/thumb/:slug/*` — never the legacy `/api/fs/thumb?path=`.
// `roots()` is the one `/api/fs/*` call that stays: it feeds pre-registration
// folder pickers, which by definition have no library slug to address by.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom, of } from 'rxjs';
import { FilesystemBrowseService, addressForAbsPath } from './filesystem-browse.service';
import { API_BASE_URL } from './api-base-url.token';
import { LibraryStore } from '../state/library-store.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import { HttpLibrarySource } from '../addressing/http-library-source';
import {
  SERVER_LIBRARY_IO,
  type ApiFolder,
  type ServerLibraryIo,
} from '../workspace/server-library-io';

function folder(id: string, path: string, slug?: string): ApiFolder {
  return {
    id,
    path,
    ...(slug !== undefined ? { slug } : {}),
    label: id,
    last_scan: null,
    file_count: 0,
    created_at: '2026-01-01T00:00:00Z',
  };
}

const MAIN = folder('lib1', '/photos/library', 'library');
const NESTED = folder('lib2', '/photos/library/2026', 'twenty-six');
const NO_SLUG = folder('64f0c0ffee', '/mnt/legacy');

describe('addressForAbsPath', () => {
  it('maps a path under a registered library to slug:relPath', () => {
    expect(addressForAbsPath('/photos/library/2025/a.dng', [MAIN])).toEqual({
      slug: 'library',
      relPath: '2025/a.dng',
    });
  });

  it('picks the longest matching library root when roots nest', () => {
    expect(addressForAbsPath('/photos/library/2026/b.dng', [MAIN, NESTED])).toEqual({
      slug: 'twenty-six',
      relPath: 'b.dng',
    });
  });

  it('never matches on a bare string prefix (sibling roots sharing a prefix)', () => {
    expect(addressForAbsPath('/photos/library2/c.dng', [MAIN])).toBeNull();
  });

  it('maps the library root itself to an empty relPath and tolerates a trailing slash', () => {
    expect(addressForAbsPath('/photos/library', [folder('x', '/photos/library/', 'lib')])).toEqual({
      slug: 'lib',
      relPath: '',
    });
  });

  it('falls back to the folder id when the server sent no slug', () => {
    expect(addressForAbsPath('/mnt/legacy/d.dng', [NO_SLUG])).toEqual({
      slug: '64f0c0ffee',
      relPath: 'd.dng',
    });
  });

  it('returns null when no registered library owns the path', () => {
    expect(addressForAbsPath('/elsewhere/e.dng', [MAIN, NESTED])).toBeNull();
  });
});

describe('FilesystemBrowseService', () => {
  let service: FilesystemBrowseService;
  let store: LibraryStore;
  let http: HttpTestingController;
  let listFolders: ReturnType<typeof vi.fn>;
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    // jsdom has no object-URL implementation; assign plain fns (vi.spyOn
    // throws on a missing property) and restore afterwards.
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    let n = 0;
    URL.createObjectURL = () => `blob:thumb-${++n}`;
    URL.revokeObjectURL = () => {};

    listFolders = vi.fn(() => of([MAIN]));
    const serverLibrary = { listFolders } as unknown as ServerLibraryIo;

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_SOURCE, useExisting: HttpLibrarySource },
        { provide: SERVER_LIBRARY_IO, useValue: serverLibrary },
      ],
    });
    service = TestBed.inject(FilesystemBrowseService);
    store = TestBed.inject(LibraryStore);
    http = TestBed.inject(HttpTestingController);
  });

  /** Address resolution is async (it may await `/api/folders` first), so the
   * thumb request is issued a few microtasks after the call. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  afterEach(() => {
    http.verify();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it('roots() GETs /api/fs/roots and unwraps the array', async () => {
    const promise = firstValueFrom(service.roots());
    http.expectOne('/api/fs/roots').flush({ roots: ['/', '/Volumes'] });
    expect(await promise).toEqual(['/', '/Volumes']);
  });

  it('getThumbBlobUrl fetches /api/thumb/:slug/* for a path under a registered library', async () => {
    store.registeredFolders.set([MAIN]);
    const promise = service.getThumbBlobUrl('/photos/library/2025/My Photo #3.JPG');
    await settle();

    const req = http.expectOne('/api/thumb/library/2025/My%20Photo%20%233.JPG');
    expect(req.request.method).toBe('GET');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['avif'], { type: 'image/avif' }));

    expect(await promise).toBe('blob:thumb-1');
    expect(listFolders).not.toHaveBeenCalled();
  });

  it('shares one request between concurrent and repeated calls for the same path', async () => {
    store.registeredFolders.set([MAIN]);
    const first = service.getThumbBlobUrl('/photos/library/a.dng');
    const second = service.getThumbBlobUrl('/photos/library/a.dng');
    expect(second).toBe(first);
    await settle();

    http.expectOne('/api/thumb/library/a.dng').flush(new Blob(['x']));
    expect(await first).toBe('blob:thumb-1');

    // A later call after resolution still hits the cache — no new request.
    expect(await service.getThumbBlobUrl('/photos/library/a.dng')).toBe('blob:thumb-1');
    http.expectNone('/api/thumb/library/a.dng');
  });

  it('loads the registered libraries once when the store is still empty', async () => {
    expect(store.registeredFolders()).toEqual([]);
    const promise = service.getThumbBlobUrl('/photos/library/b.dng');
    // Resolution awaits listFolders() before the thumb request goes out.
    await settle();
    http.expectOne('/api/thumb/library/b.dng').flush(new Blob(['x']));
    expect(await promise).toBe('blob:thumb-1');
    expect(listFolders).toHaveBeenCalledTimes(1);
    expect(store.registeredFolders()).toEqual([MAIN]);
  });

  it('rejects without a request when no registered library owns the path', async () => {
    store.registeredFolders.set([MAIN]);
    await expect(service.getThumbBlobUrl('/elsewhere/c.dng')).rejects.toThrow(
      /not under a registered library/,
    );
    http.expectNone((r) => r.url.startsWith('/api/thumb'));
  });

  it('rejects on a 202 (not indexed yet) and drops the cache entry so the next call retries', async () => {
    store.registeredFolders.set([MAIN]);
    const first = service.getThumbBlobUrl('/photos/library/d.dng');
    await settle();
    http.expectOne('/api/thumb/library/d.dng').flush(null, { status: 202, statusText: 'Accepted' });
    await expect(first).rejects.toThrow(/not ready/);

    const retry = service.getThumbBlobUrl('/photos/library/d.dng');
    expect(retry).not.toBe(first);
    await settle();
    http.expectOne('/api/thumb/library/d.dng').flush(new Blob(['x']));
    expect(await retry).toBe('blob:thumb-1');
  });

  it('clearThumbCache revokes and forgets every cached URL', async () => {
    store.registeredFolders.set([MAIN]);
    const revoked: string[] = [];
    URL.revokeObjectURL = (u: string) => {
      revoked.push(u);
    };
    const promise = service.getThumbBlobUrl('/photos/library/e.dng');
    await settle();
    http.expectOne('/api/thumb/library/e.dng').flush(new Blob(['x']));
    await promise;

    service.clearThumbCache();
    await Promise.resolve();
    expect(revoked).toEqual(['blob:thumb-1']);

    const again = service.getThumbBlobUrl('/photos/library/e.dng');
    await settle();
    http.expectOne('/api/thumb/library/e.dng').flush(new Blob(['x']));
    expect(await again).toBe('blob:thumb-2');
  });
});
