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
      source_addresses: ['lib1:a.dng', 'lib1:b.dng'],
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
      source_addresses: ['lib1:a.dng'],
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

  describe('RAW+JPEG stacks (#5846)', () => {
    const options = { template: 'Trip-{n}', sequenceStart: 1, sequencePadWidth: 2 };
    const stacked = {
      address: 'lib1:IMG_1.CR3',
      filename: 'IMG_1.CR3',
      id: 'id-raw',
      companion: { address: 'lib1:IMG_1.JPG', filename: 'IMG_1.JPG' },
    };

    function flushRawRename(newFilename: string) {
      http.expectOne('/api/assets/batch-rename').flush({
        summary: { total: 1, relocated: 1, skipped: 0, failed: 0 },
        results: [
          {
            id: 'id-raw',
            kind: 'relocated',
            old_filename: 'IMG_1.CR3',
            new_filename: newFilename,
            renamed_on_collision: false,
            extension_changed: false,
          },
        ],
      });
    }

    it('carries the companion address through resolveIds', () => {
      let out: unknown;
      svc
        .resolveIds([
          { address: stacked.address, filename: stacked.filename, companion: stacked.companion },
        ])
        .subscribe((r) => (out = r));
      http.expectOne(`/api/assets/by-address?address=${stacked.address}`).flush(detail('id-raw'));
      expect(out).toEqual([
        {
          address: stacked.address,
          filename: stacked.filename,
          id: 'id-raw',
          companion: stacked.companion,
        },
      ]);
    });

    const renamedBody = (name: string) => ({
      new_abs_path: `/lib/${name}`,
      new_path: '',
      new_filename: name,
      renamed_on_collision: false,
      extension_changed: false,
    });

    it('renames each relocated RAW’s JPEG to the RAW’s resulting stem, one tile in the summary', () => {
      let out: BatchRenameApplyResult | undefined;
      svc.apply([stacked], options, 'auto-suffix').subscribe((r) => (out = r));
      flushRawRename('Trip-01.CR3');

      http.expectOne('/api/assets/by-address?address=lib1:IMG_1.JPG').flush(detail('id-jpg'));
      const rename = http.expectOne('/api/assets/id-jpg/rename');
      expect(rename.request.body).toMatchObject({
        new_filename: 'Trip-01.JPG',
        collision: 'skip',
        source_address: 'lib1:IMG_1.JPG',
      });
      rename.flush(renamedBody('Trip-01.JPG'));

      expect(out?.summary).toEqual({ total: 1, relocated: 1, skipped: 0, failed: 0 });
      expect(out?.results.at(-1)).toEqual({
        address: 'lib1:IMG_1.JPG',
        kind: 'relocated',
        oldFilename: 'IMG_1.JPG',
        newFilename: 'Trip-01.JPG',
        renamedOnCollision: false,
        extensionChanged: false,
      });
    });

    it('never sends the batch’s Replace to the JPEG: a taken JPEG name is skipped and named', () => {
      let out: BatchRenameApplyResult | undefined;
      svc.apply([stacked], options, 'replace').subscribe((r) => (out = r));
      flushRawRename('Trip-01.CR3');

      http.expectOne('/api/assets/by-address?address=lib1:IMG_1.JPG').flush(detail('id-jpg'));
      const rename = http.expectOne('/api/assets/id-jpg/rename');
      expect(rename.request.body).toMatchObject({ new_filename: 'Trip-01.JPG', collision: 'skip' });
      rename.flush({ skipped: true, reason: 'collision' });

      expect(out?.summary).toEqual({ total: 1, relocated: 0, skipped: 1, failed: 0 });
      expect(out?.results.at(-1)).toEqual({
        address: 'lib1:IMG_1.JPG',
        kind: 'skipped',
        reason: 'Trip-01.JPG already exists, so IMG_1.JPG kept its name',
      });
    });

    it('Keep Both moves the pair together to one stem free for both files', () => {
      let out: BatchRenameApplyResult | undefined;
      svc.apply([stacked], options, 'keep-both').subscribe((r) => (out = r));
      flushRawRename('Trip-01.CR3');

      http.expectOne('/api/assets/by-address?address=lib1:IMG_1.JPG').flush(detail('id-jpg'));
      http.expectOne('/api/assets/id-jpg/rename').flush({ skipped: true, reason: 'collision' });
      http.expectOne('/api/folder/lib1').flush({
        images: [{ name: 'Trip-01.CR3' }, { name: 'Trip-01.JPG' }, { name: 'IMG_1.JPG' }],
        files: [{ name: 'Trip-01.1.JPG' }],
        sidecars: [{ name: 'Trip-01.xmp' }],
      });
      http.expectOne('/api/assets/by-address?address=lib1:Trip-01.CR3').flush(detail('id-raw'));
      const raw = http.expectOne('/api/assets/id-raw/rename');
      expect(raw.request.body).toMatchObject({ new_filename: 'Trip-01.2.CR3', collision: 'skip' });
      raw.flush(renamedBody('Trip-01.2.CR3'));
      http.expectOne('/api/assets/by-address?address=lib1:IMG_1.JPG').flush(detail('id-jpg'));
      const jpg = http.expectOne('/api/assets/id-jpg/rename');
      expect(jpg.request.body).toMatchObject({ new_filename: 'Trip-01.2.JPG', collision: 'skip' });
      jpg.flush(renamedBody('Trip-01.2.JPG'));

      expect(out?.summary).toEqual({ total: 1, relocated: 1, skipped: 0, failed: 0 });
      expect(out?.results.map((r) => (r.kind === 'relocated' ? r.newFilename : r.kind))).toEqual([
        'Trip-01.2.CR3',
        'Trip-01.2.JPG',
      ]);
    });

    it('reports a JPEG that cannot be renamed, counting its tile as failed', () => {
      let out: BatchRenameApplyResult | undefined;
      svc.apply([stacked], options, 'skip').subscribe((r) => (out = r));
      flushRawRename('Trip-01.CR3');

      http.expectOne('/api/assets/by-address?address=lib1:IMG_1.JPG').flush(detail('id-jpg'));
      http
        .expectOne('/api/assets/id-jpg/rename')
        .flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });

      expect(out?.summary).toEqual({ total: 1, relocated: 0, skipped: 0, failed: 1 });
      expect(out?.results.at(-1)).toMatchObject({ address: 'lib1:IMG_1.JPG', kind: 'error' });
    });

    it('lists the JPEG in the preview, under the name it will take', () => {
      let out: BatchRenamePreviewItem[] = [];
      svc.preview([stacked], options).subscribe((r) => (out = r));
      http.expectOne('/api/assets/batch-rename/preview').flush({
        items: [
          { old_filename: 'IMG_1.CR3', new_filename: 'Trip-01.CR3', error: null, duplicate: false },
        ],
      });

      expect(out).toEqual([
        {
          address: 'lib1:IMG_1.CR3',
          oldFilename: 'IMG_1.CR3',
          newFilename: 'Trip-01.CR3',
          error: null,
          duplicate: false,
        },
        {
          address: 'lib1:IMG_1.JPG',
          oldFilename: 'IMG_1.JPG',
          newFilename: 'Trip-01.JPG',
          error: null,
          duplicate: false,
        },
      ]);
    });

    it('leaves the JPEG alone when its RAW was skipped', () => {
      let out: BatchRenameApplyResult | undefined;
      svc.apply([stacked], options, 'skip').subscribe((r) => (out = r));
      http.expectOne('/api/assets/batch-rename').flush({
        summary: { total: 1, relocated: 0, skipped: 1, failed: 0 },
        results: [{ id: 'id-raw', kind: 'skipped', reason: 'collision' }],
      });

      expect(out?.summary).toEqual({ total: 1, relocated: 0, skipped: 1, failed: 0 });
    });
  });
});
