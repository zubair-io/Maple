import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SidecarSaveStateService } from '../../xmp/sidecar-save-state.service';
import { SaveStatusComponent } from './save-status.component';

describe('SaveStatusComponent', () => {
  let fixture: ComponentFixture<SaveStatusComponent>;
  let state: SidecarSaveStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SaveStatusComponent] });
    fixture = TestBed.createComponent(SaveStatusComponent);
    state = TestBed.inject(SidecarSaveStateService);
  });

  it('announces unsaved work while a sidecar is queued', () => {
    state.queued('asset-1');
    fixture.detectChanges();

    const notice = fixture.nativeElement.querySelector('[role="status"]');
    expect(notice?.textContent).toContain('Saving edits');
  });

  it('shows a persistent alert when saving fails', () => {
    const revision = state.queued('asset-1');
    state.failed('asset-1', revision, new Error('Permission denied'));
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Edits are not saved');
    expect(alert?.textContent).toContain('Permission denied');
  });

  it('ignores completion from an older write revision', () => {
    const stale = state.queued('asset-1');
    state.saving('asset-1', stale);
    state.queued('asset-1');
    state.saved('asset-1', stale);
    fixture.detectChanges();

    expect(state.phase()).toBe('unsaved');
  });

  it('keeps a failure visible when a different asset saves later', () => {
    const failed = state.queued('asset-1');
    const saved = state.queued('asset-2');
    state.failed('asset-1', failed, new Error('Disk full'));
    state.saved('asset-2', saved);

    expect(state.phase()).toBe('error');
    expect(state.error()).toBe('Disk full');
    expect(state.hasUnsavedChanges()).toBe(true);
  });
});
