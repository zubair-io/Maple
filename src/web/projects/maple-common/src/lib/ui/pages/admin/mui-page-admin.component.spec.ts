import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageAdminComponent } from './mui-page-admin.component';

describe('MuiPageAdminComponent', () => {
  it('renders Pipeline Monitor in the Pane by default, with the section list in Nav', () => {
    const fixture = TestBed.createComponent(MuiPageAdminComponent);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[slot=nav] mui-list-row').length).toBe(4);
    expect(el.querySelector('mui-pipeline-monitor')).toBeTruthy();
  });

  it('swaps the Pane across Setup Wizard / Backup Monitor / Diagnostics as Nav selection changes', () => {
    const fixture = TestBed.createComponent(MuiPageAdminComponent);
    fixture.detectChanges();

    fixture.componentInstance.activeSectionId.set('setup');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-setup-wizard')).toBeTruthy();

    fixture.componentInstance.activeSectionId.set('backup');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-backup-monitor')).toBeTruthy();

    fixture.componentInstance.activeSectionId.set('diagnostics');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-diagnostics')).toBeTruthy();
  });

  it('applies a stage retry back into the Pipeline Monitor stage data', () => {
    const fixture = TestBed.createComponent(MuiPageAdminComponent);
    fixture.detectChanges();

    fixture.componentInstance.onStageRetried('describe');
    fixture.detectChanges();

    expect(
      fixture.componentInstance.pipelineStages().find((s) => s.id === 'describe')?.status,
    ).toBe('running');
  });
});
