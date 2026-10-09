import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { CloudBackupService, type BackupCatalog } from '@maple-common';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupRecoveryComponent } from './backup-recovery.component';

const catalog: BackupCatalog = {
  purges: [],
  entries: [
    {
      version: 1,
      libraryId: 'library',
      entryId: 'entry',
      assetId: 'asset',
      sequence: 1,
      state: 'active',
      originalPath: 'one.raw',
      currentPath: 'one.raw',
      deletedAt: null,
      hidden: false,
      files: [],
    },
  ],
};
describe('BackupRecoveryComponent', () => {
  let fixture: ComponentFixture<BackupRecoveryComponent>;
  const api = {
    catalog: vi.fn(),
    restoreJobs: vi.fn(),
    previewRestore: vi.fn(),
    restore: vi.fn(),
    restoreJob: vi.fn(),
    cancelRestore: vi.fn(),
    resumeRestore: vi.fn(),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    api.catalog.mockReturnValue(of(catalog));
    api.restoreJobs.mockReturnValue(of([]));
    api.previewRestore.mockReturnValue(of({ files: 2, bytes: 30, entries: 1, gaps: [] }));
    api.restore.mockReturnValue(of({ jobId: 'job' }));
    api.cancelRestore.mockReturnValue(of({ ok: true }));
    api.resumeRestore.mockReturnValue(of({ ok: true }));
    api.restoreJob.mockReturnValue(
      of({
        id: 'job',
        status: 'done',
        progress: { current: 2, total: 2 },
        error: null,
        cancel_requested: false,
        result: null,
      }),
    );
    await TestBed.configureTestingModule({
      imports: [BackupRecoveryComponent],
      providers: [{ provide: CloudBackupService, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(BackupRecoveryComponent);
    fixture.componentRef.setInput('destinationId', 'destination');
  });
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  const el = (): HTMLElement => fixture.nativeElement;
  function button(label: string): HTMLButtonElement {
    const element = Array.from(el().querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === label,
    );
    if (!element) throw new Error(`missing button ${label}`);
    return element;
  }
  function target(value: string): void {
    const field = el().querySelector<HTMLInputElement>('#backup-restore-target');
    if (!field) throw new Error('missing restore target');
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }
  it('requires a complete preview and invalidates it when the target changes', async () => {
    await settle();
    target('/Photos/Recovered');
    expect(button('Restore verified files').disabled).toBe(true);
    button('Preview recovery').click();
    await settle();
    expect(api.previewRestore).toHaveBeenCalledWith('destination', {
      targetPath: '/Photos/Recovered',
      includeTrash: false,
    });
    expect(button('Restore verified files').disabled).toBe(false);
    target('/Photos/Different');
    expect(button('Restore verified files').disabled).toBe(true);
    expect(api.restore).not.toHaveBeenCalled();
  });
  it('blocks recovery when preview identifies gaps', async () => {
    api.previewRestore.mockReturnValue(
      of({ files: 2, bytes: 30, entries: 1, gaps: ['Original object is missing'] }),
    );
    await settle();
    target('/Photos/Recovered');
    button('Preview recovery').click();
    await settle();
    expect(el().textContent).toContain('Original object is missing');
    expect(button('Restore verified files').disabled).toBe(true);
  });
  it('submits the exact previewed request and shows durable server job progress', async () => {
    await settle();
    target('/Photos/Recovered');
    button('Preview recovery').click();
    await settle();
    button('Restore verified files').click();
    await settle();
    expect(api.restore).toHaveBeenCalledWith('destination', {
      targetPath: '/Photos/Recovered',
      includeTrash: false,
    });
    expect(api.restoreJob).toHaveBeenCalledWith('job');
    expect(el().textContent).toContain('Recovery done');
  });
  it('never broadens an unavailable entry into a whole-library restore', async () => {
    await settle();
    target('/Photos/Recovered');
    const component = fixture.componentInstance as unknown as {
      selection: { set(value: string): void };
    };
    component.selection.set(JSON.stringify({ entryId: 'vanished', sequence: 7 }));
    fixture.detectChanges();
    button('Preview recovery').click();
    await settle();
    expect(api.previewRestore).not.toHaveBeenCalled();
    expect(el().textContent).toContain('selected backup entry is unavailable');
  });
  it('sends a single-photo selection using the server entryId/sequence contract', async () => {
    await settle();
    target('/Photos/Recovered');
    const component = fixture.componentInstance as unknown as {
      selection: { set(value: string): void };
    };
    component.selection.set(JSON.stringify({ entryId: 'entry', sequence: 1 }));
    fixture.detectChanges();
    button('Preview recovery').click();
    await settle();
    expect(api.previewRestore).toHaveBeenCalledWith('destination', {
      targetPath: '/Photos/Recovered',
      includeTrash: false,
      entryId: 'entry',
      sequence: 1,
    });
  });
  it('resumes monitoring an active server recovery after a page reload', async () => {
    api.restoreJobs.mockReturnValue(
      of([{ id: 'existing-job', status: 'running', progress: { current: 1, total: 3 } }]),
    );
    await settle();
    expect(api.restoreJob).toHaveBeenCalledWith('existing-job');
    expect(api.restore).not.toHaveBeenCalled();
  });
  it.each(['failed', 'cancelled'] as const)(
    'requeues a %s job and restarts polling with the same job ID',
    async (status) => {
      const job = {
        id: 'retained-job',
        status,
        progress: { current: 1, total: 3 },
        error: 'Google connection interrupted',
        cancel_requested: status === 'cancelled',
        result: null,
      };
      api.restoreJobs.mockReturnValue(of([job]));
      api.restoreJob.mockReturnValue(of(job));
      await settle();
      button('View recovery status').click();
      await settle();
      expect(el().textContent).toContain(`Recovery ${status}`);
      api.restoreJob.mockReturnValue(
        of({ ...job, status: 'queued', error: null, cancel_requested: false }),
      );
      button('Resume recovery').click();
      await settle();
      expect(api.resumeRestore).toHaveBeenCalledWith('destination', 'retained-job');
      expect(api.restoreJob).toHaveBeenCalledTimes(2);
      expect(api.restoreJob).toHaveBeenLastCalledWith('retained-job');
      expect(el().textContent).toContain('Recovery queued');
      expect(button('Preview recovery').disabled).toBe(true);
      expect(api.restore).not.toHaveBeenCalled();
    },
  );
  it('keeps a failed job available for retry when the resume request fails', async () => {
    const job = {
      id: 'retained-job',
      status: 'failed',
      progress: { current: 1, total: 3 },
      error: 'Network failure',
      cancel_requested: false,
      result: null,
    };
    api.restoreJobs.mockReturnValue(of([job]));
    api.restoreJob.mockReturnValue(of(job));
    api.resumeRestore.mockReturnValue(
      throwError(() => new Error('Reconnect Google before resuming.')),
    );
    await settle();
    button('View recovery status').click();
    await settle();
    button('Resume recovery').click();
    await settle();
    expect(el().textContent).toContain('Reconnect Google before resuming.');
    expect(button('Resume recovery').disabled).toBe(false);
    expect(api.restoreJob).toHaveBeenCalledTimes(1);
    expect(api.restore).not.toHaveBeenCalled();
  });
  it('retains cancellation for a running recovery without starting a new job', async () => {
    const job = {
      id: 'retained-job',
      status: 'running',
      progress: { current: 1, total: 3 },
      error: null,
      cancel_requested: false,
      result: null,
    };
    api.restoreJobs.mockReturnValue(of([job]));
    api.restoreJob.mockReturnValue(of(job));
    await settle();
    button('Cancel recovery').click();
    await settle();
    expect(api.cancelRestore).toHaveBeenCalledWith('retained-job');
    expect(api.resumeRestore).not.toHaveBeenCalled();
    expect(api.restore).not.toHaveBeenCalled();
  });
});
