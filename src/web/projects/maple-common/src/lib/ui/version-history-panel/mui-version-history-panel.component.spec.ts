import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiVersionHistoryPanelComponent } from './mui-version-history-panel.component';

const VERSIONS = [
  {
    id: 'v3',
    label: 'You — auto-save',
    timestampValue: new Date('2026-03-01T00:00:00Z'),
    current: true,
  },
  { id: 'v2', label: 'You — exposure pass', timestampValue: new Date('2026-02-01T00:00:00Z') },
  { id: 'v1', label: 'You — initial import', timestampValue: new Date('2026-01-01T00:00:00Z') },
];

function render(): ComponentFixture<MuiVersionHistoryPanelComponent> {
  TestBed.configureTestingModule({ imports: [MuiVersionHistoryPanelComponent] });
  const fixture = TestBed.createComponent(MuiVersionHistoryPanelComponent);
  fixture.componentRef.setInput('versions', VERSIONS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiVersionHistoryPanelComponent', () => {
  it('shows a spinner while loading', () => {
    TestBed.configureTestingModule({ imports: [MuiVersionHistoryPanelComponent] });
    const fixture = TestBed.createComponent(MuiVersionHistoryPanelComponent);
    fixture.componentRef.setInput('versions', VERSIONS);
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-spinner')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('mui-list-row')).toBeNull();
  });

  it('shows an empty state when there is no history', () => {
    TestBed.configureTestingModule({ imports: [MuiVersionHistoryPanelComponent] });
    const fixture = TestBed.createComponent(MuiVersionHistoryPanelComponent);
    fixture.componentRef.setInput('versions', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-empty-state')).not.toBeNull();
  });

  it('the current version shows a "Current" label and no restore button', () => {
    const fixture = render();
    const rows = fixture.nativeElement.querySelectorAll('mui-list-row');
    const currentRow = rows[0] as HTMLElement;
    expect(currentRow.querySelector('mui-button')).toBeNull();
    expect(currentRow.textContent).toContain('Current');
  });

  it('non-current versions show a Restore button', () => {
    const fixture = render();
    const rows = fixture.nativeElement.querySelectorAll('mui-list-row');
    const nonCurrentRow = rows[1] as HTMLElement;
    expect(nonCurrentRow.querySelector('mui-button')).not.toBeNull();
    expect(nonCurrentRow.textContent).toContain('Restore');
  });

  it('restoring requires a confirm dialog round trip before emitting restored', () => {
    const fixture = render();
    const restored: string[] = [];
    fixture.componentInstance.restored.subscribe((id) => restored.push(id));

    const rows = fixture.nativeElement.querySelectorAll('mui-list-row');
    const restoreButton = (rows[1] as HTMLElement).querySelector(
      'mui-button button',
    ) as HTMLButtonElement;
    restoreButton.click();
    fixture.detectChanges();

    expect(restored).toEqual([]);
    expect(fixture.componentInstance.pendingRestoreId()).toBe('v2');
    expect(fixture.nativeElement.querySelector('.mui-dialog-scrim')).not.toBeNull();

    const dialogButtons = fixture.nativeElement.querySelectorAll('.mui-dialog .actions button');
    (dialogButtons[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(restored).toEqual(['v2']);
    expect(fixture.componentInstance.pendingRestoreId()).toBeNull();
  });

  it('dismissing the confirm dialog does not emit restored', () => {
    const fixture = render();
    const restored: string[] = [];
    fixture.componentInstance.restored.subscribe((id) => restored.push(id));

    const rows = fixture.nativeElement.querySelectorAll('mui-list-row');
    const restoreButton = (rows[1] as HTMLElement).querySelector(
      'mui-button button',
    ) as HTMLButtonElement;
    restoreButton.click();
    fixture.detectChanges();

    const dialogButtons = fixture.nativeElement.querySelectorAll('.mui-dialog .actions button');
    (dialogButtons[0] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(restored).toEqual([]);
    expect(fixture.componentInstance.pendingRestoreId()).toBeNull();
  });
});
