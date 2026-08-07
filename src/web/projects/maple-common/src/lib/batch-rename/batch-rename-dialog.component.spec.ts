// Uses vitest fake timers for the 250ms preview debounce (same pattern as
// `batch-metadata-panel.geocode-refile.spec.ts` — Angular's `fakeAsync` is
// not available without zone-testing, which `@angular/build:unit-test`
// does not bundle).

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { of, throwError } from 'rxjs';
import { BatchRenameDialogComponent } from './batch-rename-dialog.component';
import { BatchRenameService } from './batch-rename.service';
import type {
  BatchRenameApplyResult,
  BatchRenamePreviewItem,
  BatchRenameSelection,
  ResolvedBatchRenameId,
} from './batch-rename.types';

const SELECTIONS: BatchRenameSelection[] = [
  { address: 'lib1:a.dng', filename: 'a.dng' },
  { address: 'lib1:b.dng', filename: 'b.dng' },
];

const RESOLVED: ResolvedBatchRenameId[] = [
  { address: 'lib1:a.dng', filename: 'a.dng', id: 'id-a' },
  { address: 'lib1:b.dng', filename: 'b.dng', id: 'id-b' },
];

const PREVIEW_OK: BatchRenamePreviewItem[] = [
  {
    address: 'lib1:a.dng',
    oldFilename: 'a.dng',
    newFilename: 'trip_1.dng',
    error: null,
    duplicate: false,
  },
  {
    address: 'lib1:b.dng',
    oldFilename: 'b.dng',
    newFilename: 'trip_2.dng',
    error: null,
    duplicate: false,
  },
];

interface ServiceStubOverrides {
  resolveIds?: Mock;
  preview?: Mock;
  apply?: Mock;
}

@Component({
  standalone: true,
  imports: [BatchRenameDialogComponent],
  template: `@if (mounted()) {
    <app-batch-rename-dialog
      [selections]="selections()"
      (dismiss)="onDismiss()"
      (applied)="onApplied()"
    />
  }`,
})
class HostComponent {
  selections = signal<BatchRenameSelection[]>(SELECTIONS);
  mounted = signal(true);
  dismissCount = 0;
  appliedCount = 0;
  onDismiss(): void {
    this.dismissCount++;
    this.mounted.set(false);
  }
  onApplied(): void {
    this.appliedCount++;
  }
}

function setup(overrides: ServiceStubOverrides = {}) {
  const service = {
    resolveIds: vi.fn(() => of(RESOLVED)),
    preview: vi.fn(() => of(PREVIEW_OK)),
    apply: vi.fn(() =>
      of<BatchRenameApplyResult>({
        summary: { total: 2, relocated: 2, skipped: 0, failed: 0 },
        results: [
          {
            address: 'lib1:a.dng',
            kind: 'relocated',
            oldFilename: 'a.dng',
            newFilename: 'trip_1.dng',
            renamedOnCollision: false,
            extensionChanged: false,
          },
          {
            address: 'lib1:b.dng',
            kind: 'relocated',
            oldFilename: 'b.dng',
            newFilename: 'trip_2.dng',
            renamedOnCollision: false,
            extensionChanged: false,
          },
        ],
      }),
    ),
    ...overrides,
  };

  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [{ provide: BatchRenameService, useValue: service }],
  });

  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, service };
}

function dialog(fixture: ReturnType<typeof setup>['fixture']): BatchRenameDialogComponent {
  return fixture.debugElement.children[0].componentInstance as BatchRenameDialogComponent;
}

/** Advance fake timers past the 250ms preview debounce and settle signals. */
function drainDebounce(fixture: ReturnType<typeof setup>['fixture']): void {
  vi.advanceTimersByTime(300);
  fixture.detectChanges();
}

describe('BatchRenameDialogComponent (#2640)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves ids on init and runs an initial preview', () => {
    const { fixture, service } = setup();
    drainDebounce(fixture);

    expect(service.resolveIds).toHaveBeenCalledWith(SELECTIONS);
    expect(service.preview).toHaveBeenCalledWith(RESOLVED, {
      template: '{original}',
      sequenceStart: 1,
      sequencePadWidth: 0,
    });
    const rows = fixture.nativeElement.querySelectorAll('.brn-preview-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('trip_1.dng');
  });

  it('debounces template edits before calling preview again', () => {
    const { fixture, service } = setup();
    drainDebounce(fixture);
    service.preview.mockClear();

    const d = dialog(fixture);
    d.onTemplateInput('{original}_{n}');
    vi.advanceTimersByTime(100);
    d.onTemplateInput('{original}_{n}.{ext}');
    expect(service.preview).not.toHaveBeenCalled();
    drainDebounce(fixture);

    expect(service.preview).toHaveBeenCalledTimes(1);
    expect(service.preview).toHaveBeenCalledWith(RESOLVED, {
      template: '{original}_{n}.{ext}',
      sequenceStart: 1,
      sequencePadWidth: 0,
    });
  });

  it('insertToken appends to the current template and re-runs preview', () => {
    const { fixture, service } = setup();
    drainDebounce(fixture);
    service.preview.mockClear();

    const d = dialog(fixture);
    d.insertToken('{n}');
    drainDebounce(fixture);

    expect(d.template()).toBe('{original}{n}');
    expect(service.preview).toHaveBeenCalledWith(
      RESOLVED,
      expect.objectContaining({ template: '{original}{n}' }),
    );
  });

  it('Apply calls the service with the current template/collision and shows per-file results', () => {
    const { fixture, service } = setup();
    drainDebounce(fixture);

    const applyBtn = fixture.nativeElement.querySelector('.brn-btn-primary') as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(false);
    applyBtn.click();
    fixture.detectChanges();

    expect(service.apply).toHaveBeenCalledWith(
      RESOLVED,
      { template: '{original}', sequenceStart: 1, sequencePadWidth: 0 },
      'auto-suffix',
    );
    expect(fixture.nativeElement.querySelector('.brn-summary').textContent).toContain(
      '2 of 2 renamed',
    );
    const rows = fixture.nativeElement.querySelectorAll('.brn-preview-row');
    expect(rows.length).toBe(2);
  });

  it('summarizes a partial failure with a uniform skip reason, matching the design doc example', () => {
    const { fixture } = setup({
      apply: vi.fn(() =>
        of<BatchRenameApplyResult>({
          summary: { total: 20, relocated: 18, skipped: 2, failed: 0 },
          results: [
            { address: 'lib1:a.dng', kind: 'skipped', reason: 'collision' },
            { address: 'lib1:b.dng', kind: 'skipped', reason: 'collision' },
          ],
        }),
      ),
    });
    drainDebounce(fixture);

    (fixture.nativeElement.querySelector('.brn-btn-primary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.brn-summary').textContent).toContain(
      '18 of 20 renamed, 2 skipped: collision',
    );
  });

  it('does not roll back or block on an apply error; shows it and returns to the edit phase', () => {
    const { fixture } = setup({
      apply: vi.fn(() => throwError(() => new Error('network down'))),
    });
    drainDebounce(fixture);

    (fixture.nativeElement.querySelector('.brn-btn-primary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.brn-error')?.textContent).toContain(
      'network down',
    );
    expect(dialog(fixture).phase()).toBe('edit');
  });

  it('Cancel while idle emits dismiss without calling apply', () => {
    const { fixture, service } = setup();
    drainDebounce(fixture);
    const host = fixture.componentInstance;

    (fixture.nativeElement.querySelector('.brn-btn-ghost') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(service.apply).not.toHaveBeenCalled();
    expect(host.dismissCount).toBe(1);
  });

  it('surfaces an unresolved-selection warning and still lets the resolvable rows preview', () => {
    const { fixture } = setup({
      resolveIds: vi.fn(() =>
        of<ResolvedBatchRenameId[]>([
          { address: 'lib1:a.dng', filename: 'a.dng', id: 'id-a' },
          { address: 'lib1:gone.dng', filename: 'gone.dng', id: null },
        ]),
      ),
      preview: vi.fn(() =>
        of<BatchRenamePreviewItem[]>([
          {
            address: 'lib1:a.dng',
            oldFilename: 'a.dng',
            newFilename: 'a_1.dng',
            error: null,
            duplicate: false,
          },
          {
            address: 'lib1:gone.dng',
            oldFilename: 'gone.dng',
            newFilename: null,
            error: 'Could not resolve this asset',
            duplicate: false,
          },
        ]),
      ),
    });
    drainDebounce(fixture);

    expect(fixture.nativeElement.querySelector('.brn-warning')?.textContent).toContain(
      '1 of 2 selected file could not be looked up',
    );
  });
});
