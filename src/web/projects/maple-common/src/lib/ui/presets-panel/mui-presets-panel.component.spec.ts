import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPresetsPanelComponent } from './mui-presets-panel.component';

const PRESETS = [
  { id: 'preset-1', name: 'Warm Portrait', updatedAt: new Date('2026-01-01T00:00:00Z') },
  { id: 'preset-2', name: 'Cool Landscape', updatedAt: new Date('2026-02-01T00:00:00Z') },
];

function render(): ComponentFixture<MuiPresetsPanelComponent> {
  TestBed.configureTestingModule({ imports: [MuiPresetsPanelComponent] });
  const fixture = TestBed.createComponent(MuiPresetsPanelComponent);
  fixture.componentRef.setInput('presets', PRESETS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiPresetsPanelComponent', () => {
  it('shows a spinner while loading and no rows', () => {
    TestBed.configureTestingModule({ imports: [MuiPresetsPanelComponent] });
    const fixture = TestBed.createComponent(MuiPresetsPanelComponent);
    fixture.componentRef.setInput('presets', PRESETS);
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-spinner')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('mui-list-row')).toBeNull();
  });

  it('shows an empty state when there are no presets', () => {
    TestBed.configureTestingModule({ imports: [MuiPresetsPanelComponent] });
    const fixture = TestBed.createComponent(MuiPresetsPanelComponent);
    fixture.componentRef.setInput('presets', []);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-empty-state')).not.toBeNull();
  });

  it('pressing a row emits applied with its id', () => {
    const fixture = render();
    const applied: string[] = [];
    fixture.componentInstance.applied.subscribe((id) => applied.push(id));

    const rows = fixture.nativeElement.querySelectorAll('.mui-list-row');
    (rows[1] as HTMLElement).click();

    expect(applied).toEqual(['preset-2']);
  });

  it('delete requires a confirm-dialog round trip before emitting deleted, and never triggers apply', () => {
    const fixture = render();
    const applied: string[] = [];
    const deleted: string[] = [];
    fixture.componentInstance.applied.subscribe((id) => applied.push(id));
    fixture.componentInstance.deleted.subscribe((id) => deleted.push(id));

    const deleteButton = fixture.nativeElement.querySelectorAll(
      '.mui-list-row mui-button button',
    )[0] as HTMLButtonElement;
    deleteButton.click();
    fixture.detectChanges();

    expect(applied).toEqual([]);
    expect(deleted).toEqual([]);
    expect(fixture.componentInstance.dialogMode()).toBe('confirmDelete');
    expect(fixture.nativeElement.querySelector('.mui-dialog-scrim')).not.toBeNull();

    const dialogButtons = fixture.nativeElement.querySelectorAll('.mui-dialog .actions button');
    (dialogButtons[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(deleted).toEqual(['preset-1']);
    expect(fixture.componentInstance.dialogMode()).toBe('none');
  });

  it('inline confirmMode flips the row itself instead of opening a dialog', () => {
    TestBed.configureTestingModule({ imports: [MuiPresetsPanelComponent] });
    const fixture = TestBed.createComponent(MuiPresetsPanelComponent);
    fixture.componentRef.setInput('presets', PRESETS);
    fixture.componentRef.setInput('confirmMode', 'inline');
    fixture.detectChanges();

    const applied: string[] = [];
    const deleted: string[] = [];
    fixture.componentInstance.applied.subscribe((id) => applied.push(id));
    fixture.componentInstance.deleted.subscribe((id) => deleted.push(id));

    const deleteButton = fixture.nativeElement.querySelector(
      '[data-testid="preset-delete-preset-1"]',
    ) as HTMLButtonElement;
    deleteButton.click();
    fixture.detectChanges();

    // No dialog opened; the row itself flipped into its confirm state.
    expect(fixture.componentInstance.dialogMode()).toBe('none');
    expect(fixture.nativeElement.querySelector('.mui-dialog-scrim')).toBeNull();
    const confirmRow = fixture.nativeElement.querySelector(
      '[data-testid="preset-delete-confirm-row-preset-1"]',
    );
    expect(confirmRow).not.toBeNull();
    expect(confirmRow!.textContent).toContain('Delete');
    expect(confirmRow!.textContent).toContain('Warm Portrait');

    // The confirming row is disabled — clicking it must not apply.
    (confirmRow as HTMLElement).click();
    expect(applied).toEqual([]);

    const confirmButton = fixture.nativeElement.querySelector(
      '[data-testid="preset-delete-confirm-preset-1"]',
    ) as HTMLButtonElement;
    confirmButton.click();
    fixture.detectChanges();

    expect(deleted).toEqual(['preset-1']);
    expect(
      fixture.nativeElement.querySelector('[data-testid="preset-delete-confirm-row-preset-1"]'),
    ).toBeNull();
  });

  it('inline confirmMode: cancel returns the row to normal without deleting', () => {
    TestBed.configureTestingModule({ imports: [MuiPresetsPanelComponent] });
    const fixture = TestBed.createComponent(MuiPresetsPanelComponent);
    fixture.componentRef.setInput('presets', PRESETS);
    fixture.componentRef.setInput('confirmMode', 'inline');
    fixture.detectChanges();

    const deleted: string[] = [];
    fixture.componentInstance.deleted.subscribe((id) => deleted.push(id));

    (
      fixture.nativeElement.querySelector(
        '[data-testid="preset-delete-preset-1"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector(
        '[data-testid="preset-delete-cancel-preset-1"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(deleted).toEqual([]);
    expect(
      fixture.nativeElement.querySelector('[data-testid="preset-delete-confirm-row-preset-1"]'),
    ).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="preset-apply-preset-1"]'),
    ).not.toBeNull();
  });

  it('showSaveTrigger hides the built-in header trigger and save-prompt dialog', () => {
    TestBed.configureTestingModule({ imports: [MuiPresetsPanelComponent] });
    const fixture = TestBed.createComponent(MuiPresetsPanelComponent);
    fixture.componentRef.setInput('presets', PRESETS);
    fixture.componentRef.setInput('showSaveTrigger', false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.header')).toBeNull();
    fixture.componentInstance.dialogMode.set('savePrompt');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-dialog-scrim')).toBeNull();
  });

  it('showDeleteAction hides every row’s delete trigger', () => {
    TestBed.configureTestingModule({ imports: [MuiPresetsPanelComponent] });
    const fixture = TestBed.createComponent(MuiPresetsPanelComponent);
    fixture.componentRef.setInput('presets', PRESETS);
    fixture.componentRef.setInput('showDeleteAction', false);
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="preset-delete-preset-1"]'),
    ).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="preset-apply-preset-1"]'),
    ).not.toBeNull();
  });

  it('save-prompt requires a non-empty trimmed name before emitting saved', () => {
    const fixture = render();
    const saved: string[] = [];
    fixture.componentInstance.saved.subscribe((name) => saved.push(name));

    (fixture.nativeElement.querySelector('.header mui-button button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.dialogMode()).toBe('savePrompt');

    let dialogButtons = fixture.nativeElement.querySelectorAll('.mui-dialog .actions button');
    (dialogButtons[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(saved).toEqual([]);
    // whitespace-only submission leaves the dialog closed without emitting.
    expect(fixture.componentInstance.dialogMode()).toBe('none');

    (fixture.nativeElement.querySelector('.header mui-button button') as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('.mui-dialog .control') as HTMLInputElement;
    input.value = '  Moody Blue  ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    dialogButtons = fixture.nativeElement.querySelectorAll('.mui-dialog .actions button');
    (dialogButtons[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(saved).toEqual(['Moody Blue']);
  });
});
