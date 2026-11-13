// Self Hosted commits name the head of the record they read as parent and carry the
// Web writer label; a commit the server merged is surfaced to the live editor (#4983).
// The API is stood in for by the real Rust workflow module, run in-process.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowHistoryEntry } from '../generated/workflow.generated';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import {
  initSync,
  workflow_checkpoint_xmp,
  workflow_commit_xmp,
  workflow_embed_xmp,
  workflow_read_xmp,
  workflow_reconcile_xmp,
} from '../raw-pipeline/pkg/raw_wasm';
import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';
import {
  SelfHostedWorkflowWriterService,
  type SelfHostedMerge,
} from './self-hosted-workflow-writer.service';
import { inProcessWorkflowXmp } from './testing/in-process-workflow-xmp';
import { WorkflowXmpService } from './workflow-xmp.service';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';

const PATH = '/photos/a.dng';
const culling = { rating: 1, flag: 'unflagged' as const, colorLabel: null, keywords: [] };

describe('Self Hosted workflow writer lineage', () => {
  const core = inProcessWorkflowXmp;
  const parser = new XmpParserService();
  const serializer = new XmpSerializerService();
  let disk: string;
  let afterRead: (() => void) | undefined;
  let sent: WorkflowHistoryEntry[];
  let merges: SelfHostedMerge[];
  let writer: SelfHostedWorkflowWriterService;
  const edit = (contrast: number) => ({
    before: defaultAdjustmentModel(),
    after: { ...defaultAdjustmentModel(), contrast },
    culling,
    cullingPatch: {},
    action: 'adjustment',
    label: `Contrast ${contrast}`,
  });
  const entries = () => core.read(disk).then((record) => record!.history);

  beforeAll(() => {
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    });
  });
  beforeEach(() => {
    disk = serializer.serialize(defaultAdjustmentModel(), undefined, culling);
    afterRead = undefined;
    sent = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkflowXmpService, useValue: inProcessWorkflowXmp },
        {
          provide: SERVER_WORKSPACE_PERSISTENCE,
          useValue: {
            readSidecar: () => {
              const read = disk;
              afterRead?.();
              afterRead = undefined;
              return of(read);
            },
            commitSidecar: (
              _path: string,
              expected: string | null,
              xmp: string,
              entry: WorkflowHistoryEntry,
            ) => {
              sent.push(entry);
              const stale = expected !== disk;
              const document = stale ? workflow_reconcile_xmp(expected ?? '', disk, xmp, 1) : xmp;
              const checkpoint = workflow_checkpoint_xmp(document);
              const record = workflow_read_xmp(disk);
              const candidate =
                stale || record === 'null' ? document : workflow_embed_xmp(record, xmp);
              const stored = stale ? { ...entry, adjustmentXmp: checkpoint } : entry;
              disk = workflow_commit_xmp(candidate, JSON.stringify(stored));
              return of(disk);
            },
          },
        },
      ],
    });
    writer = TestBed.inject(SelfHostedWorkflowWriterService);
    merges = [];
    writer.merged.subscribe((merge) => merges.push(merge));
  });

  it('names the record head as parent and labels the writer for every captured action', async () => {
    writer.capture(PATH, edit(10));
    writer.capture(PATH, edit(20));
    await firstValueFrom(writer.flush(PATH));

    const history = await entries();
    expect(history.map((entry) => entry.label)).toEqual(['Contrast 10', 'Contrast 20']);
    expect(sent.map((entry) => [entry.writer, entry.parentId])).toEqual([
      ['web', ''],
      ['web', history[0].id],
    ]);
    expect(merges).toEqual([]);
  });

  it('continues from the head already on disk', async () => {
    writer.capture(PATH, edit(10));
    await firstValueFrom(writer.flush(PATH));
    const [first] = await entries();

    writer.capture(PATH, edit(20));
    await firstValueFrom(writer.flush(PATH));

    expect(sent[1].parentId).toBe(first.id);
  });

  it('surfaces a commit the server merged onto an outside edit', async () => {
    afterRead = () => {
      disk = disk.replace('xmp:Rating="1"', 'xmp:Rating="4"');
    };
    writer.capture(PATH, edit(10));
    await firstValueFrom(writer.flush(PATH));

    const history = await entries();
    expect(history.map((entry) => entry.action)).toEqual(['external', 'adjustment']);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ path: PATH, variantId: 'primary', xml: disk });
    expect(merges[0].saved.model.contrast).toBe(10);
    expect(parser.parseCulling(disk).rating).toBe(4);
    expect(parser.parseAdjustmentModel(disk).model.contrast).toBe(10);
  });
});
