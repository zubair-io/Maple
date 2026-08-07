import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BatchRenameService } from './batch-rename.service';
import { API_BASE_URL } from '../api/api-base-url.token';
import type { BatchRenameApplyResult, BatchRenamePreviewItem } from './batch-rename.types';

function detail(id: string) {
  return {
    id,
    folder_id: 'lib1',
    filename: 'x.dng',
    abs_path: '/x.dng',
    size: 1,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '',
    place: null,
    faces: [],
    description: null,
    description_meta: null,
    ocr_text: null,
  };
}

describe('BatchRenameService', () => {
  let svc: BatchRenameService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        BatchRenameService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(BatchRenameService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('resolveIds looks up each address and preserves order', () => {
    let out: { address: string; filename: string; id: string | null }[] = [];
    svc
      .resolveIds([
        { address: 'lib1:a.dng', filename: 'a.dng' },
        { address: 'lib1:b.dng', filename: 'b.dng' },
      ])
      .subscribe((r) => (out = r));

    http.expectOne('/api/assets/by-address?address=lib1:a.dng').flush(detail('id-a'));
    http.expectOne('/api/assets/by-address?address=lib1:b.dng').flush(detail('id-b'));

    expect(out).toEqual([
      { address: 'lib1:a.dng', filename: 'a.dng', id: 'id-a' },
      { address: 'lib1:b.dng', filename: 'b.dng', id: 'id-b' },
    ]);
  });

  it('resolveIds marks a failed lookup id: null instead of erroring the whole batch', () => {
    let out: { address: string; filename: string; id: string | null }[] = [];
    svc
      .resolveIds([
        { address: 'lib1:a.dng', filename: 'a.dng' },
        { address: 'lib1:gone.dng', filename: 'gone.dng' },
      ])
      .subscribe((r) => (out = r));

    http.expectOne('/api/assets/by-address?address=lib1:a.dng').flush(detail('id-a'));
    http
      .expectOne('/api/assets/by-address?address=lib1:gone.dng')
      .flush({ error: 'not found' }, { status: 404, statusText: 'Not Found' });

    expect(out).toEqual([
      { address: 'lib1:a.dng', filename: 'a.dng', id: 'id-a' },
      { address: 'lib1:gone.dng', filename: 'gone.dng', id: null },
    ]);
  });

  it('preview POSTs resolved ids and maps results back to addresses in order', () => {
    let out: BatchRenamePreviewItem[] = [];
    svc
      .preview(
        [
          { address: 'lib1:a.dng', filename: 'a.dng', id: 'id-a' },
          { address: 'lib1:b.dng', filename: 'b.dng', id: 'id-b' },
        ],
        { template: '{original}_{n}.{ext}', sequenceStart: 1, sequencePadWidth: 0 },
      )
      .subscribe((r) => (out = r));

    const call = http.expectOne('/api/assets/batch-rename/preview');
    expect(call.request.body).toEqual({
      ids: ['id-a', 'id-b'],
      template: '{original}_{n}.{ext}',
      sequence_start: 1,
      sequence_pad_width: 0,
    });
    call.flush({
      items: [
        {
          id: 'id-a',
          old_filename: 'a.dng',
          new_filename: 'a_1.dng',
          error: null,
          duplicate: false,
        },
        {
          id: 'id-b',
          old_filename: 'b.dng',
          new_filename: 'b_2.dng',
          error: null,
          duplicate: false,
        },
      ],
    });

    expect(out).toEqual([
      {
        address: 'lib1:a.dng',
        oldFilename: 'a.dng',
        newFilename: 'a_1.dng',
        error: null,
        duplicate: false,
      },
      {
        address: 'lib1:b.dng',
        oldFilename: 'b.dng',
        newFilename: 'b_2.dng',
        error: null,
        duplicate: false,
      },
    ]);
  });

  it('preview skips the network entirely and reports an error row when every id is unresolved', () => {
    let out: BatchRenamePreviewItem[] = [];
    svc
      .preview([{ address: 'lib1:gone.dng', filename: 'gone.dng', id: null }], {
        template: '{original}',
        sequenceStart: 0,
        sequencePadWidth: 0,
      })
      .subscribe((r) => (out = r));

    http.expectNone('/api/assets/batch-rename/preview');
    expect(out).toEqual([
      {
        address: 'lib1:gone.dng',
        oldFilename: 'gone.dng',
        newFilename: null,
        error: 'Could not resolve this asset',
        duplicate: false,
      },
    ]);
  });

  it('apply folds unresolved rows into the summary as failures without calling the server for them', () => {
    let out: BatchRenameApplyResult | undefined;
    svc
      .apply(
        [
          { address: 'lib1:a.dng', filename: 'a.dng', id: 'id-a' },
          { address: 'lib1:gone.dng', filename: 'gone.dng', id: null },
        ],
        { template: '{original}', sequenceStart: 0, sequencePadWidth: 0 },
        'auto-suffix',
      )
      .subscribe((r) => (out = r));

    const call = http.expectOne('/api/assets/batch-rename');
    expect(call.request.body).toEqual({
      ids: ['id-a'],
      template: '{original}',
      sequence_start: 0,
      sequence_pad_width: 0,
      collision: 'auto-suffix',
    });
    call.flush({
      summary: { total: 1, relocated: 1, skipped: 0, failed: 0 },
      results: [
        {
          id: 'id-a',
          kind: 'relocated',
          old_filename: 'a.dng',
          new_filename: 'a.dng',
          renamed_on_collision: false,
          extension_changed: false,
        },
      ],
    });

    expect(out).toEqual({
      summary: { total: 2, relocated: 1, skipped: 0, failed: 1 },
      results: [
        {
          address: 'lib1:a.dng',
          kind: 'relocated',
          oldFilename: 'a.dng',
          newFilename: 'a.dng',
          renamedOnCollision: false,
          extensionChanged: false,
        },
        { address: 'lib1:gone.dng', kind: 'error', error: 'Could not resolve this asset' },
      ],
    });
  });
});
