// ToolbarActionsComponent — extracted from BrowseShellComponent (#2293
// fallow-audit-web fix). Covers the desktop inline-row vs collapsed-kebab
// presentation, server-action projection, and shared action outputs.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { Component, signal } from '@angular/core';

import { ToolbarActionsComponent } from './toolbar-actions.component';

@Component({
  standalone: true,
  imports: [ToolbarActionsComponent],
  template: `
    <app-toolbar-actions
      [collapsed]="collapsed()"
      [canCopySettings]="canCopySettings()"
      [canPasteSettings]="canPasteSettings()"
      [canSyncSettings]="canSyncSettings()"
      [selectedCount]="selectedCount()"
      [isSelecting]="isSelecting()"
      (copySettings)="copySettingsCount.update((v) => v + 1)"
      (openPasteDialog)="openPasteDialogCount.update((v) => v + 1)"
      (syncSettings)="syncSettingsCount.update((v) => v + 1)"
      (toggleSelectMode)="toggleSelectModeCount.update((v) => v + 1)"
    >
      <button type="button" aria-label="Server extension">Server action</button>
    </app-toolbar-actions>
  `,
})
class HostComponent {
  readonly collapsed = signal(false);
  readonly canCopySettings = signal(false);
  readonly canPasteSettings = signal(false);
  readonly canSyncSettings = signal(false);
  readonly selectedCount = signal(0);
  readonly isSelecting = signal(false);

  readonly copySettingsCount = signal(0);
  readonly openPasteDialogCount = signal(0);
  readonly syncSettingsCount = signal(0);
  readonly toggleSelectModeCount = signal(0);
}

describe('ToolbarActionsComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the inline pill row (no kebab) when not collapsed', () => {
    expect(el().querySelector('[data-testid="toolbar-overflow-toggle"]')).toBeNull();
    expect(el().querySelector('[aria-label="Copy settings"]')).not.toBeNull();
    expect(el().querySelector('[aria-label="Sync settings"]')).not.toBeNull();
  });

  it('projects an app-provided server action into the shared action row', () => {
    expect(el().querySelector('[aria-label="Server extension"]')).not.toBeNull();
  });

  it('collapses into a kebab menu that opens on toggle and closes on pill click', () => {
    host.collapsed.set(true);
    host.canCopySettings.set(true);
    fixture.detectChanges();

    const toggle = el().querySelector(
      '[data-testid="toolbar-overflow-toggle"]',
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(el().querySelector('[aria-label="Copy settings"]')).toBeNull();
    expect(el().querySelector('[data-testid="toolbar-overflow-menu"]')).toBeNull();

    toggle.click();
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="toolbar-overflow-menu"]')).not.toBeNull();

    const copyBtn = el().querySelector('[aria-label="Copy settings"]') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    copyBtn.click();
    fixture.detectChanges();

    expect(host.copySettingsCount()).toBe(1);
    expect(el().querySelector('[data-testid="toolbar-overflow-menu"]')).toBeNull();
  });

  it('emits openPasteDialog / syncSettings from their own pills', () => {
    host.canPasteSettings.set(true);
    host.canSyncSettings.set(true);
    fixture.detectChanges();

    (el().querySelector('[aria-label="Paste settings"]') as HTMLButtonElement).click();
    (el().querySelector('[aria-label="Sync settings"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(host.openPasteDialogCount()).toBe(1);
    expect(host.syncSettingsCount()).toBe(1);
  });

  it('disables pills whose gating input is false without rendering the inert Export action', () => {
    host.canCopySettings.set(false);
    host.selectedCount.set(3);
    fixture.detectChanges();

    const copyBtn = el().querySelector('[aria-label="Copy settings"]') as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);

    expect(el().textContent).not.toContain('Export');
  });

  // #2427 — the host must not generate a box. BrowseShell drops
  // <app-toolbar-actions> straight into its `.toolbar` flex row, and every pill
  // carries Tailwind's `flex` utility; a host box blockifies as a flex item and
  // the pills then stack vertically out of the fixed-height bar instead of
  // laying out as a row.
  it('does not generate a host box, so the pills are direct flex items of the toolbar', () => {
    const hostEl = fixture.nativeElement.querySelector('app-toolbar-actions') as HTMLElement;
    expect(getComputedStyle(hostEl).display).toBe('contents');
  });

  it('renders the Select pill, reflects isSelecting via aria-pressed, and emits toggleSelectMode on click (#2404)', () => {
    const selectBtn = el().querySelector('[aria-label="Select"]') as HTMLButtonElement;
    expect(selectBtn).not.toBeNull();
    expect(selectBtn.getAttribute('aria-pressed')).toBe('false');

    selectBtn.click();
    fixture.detectChanges();
    expect(host.toggleSelectModeCount()).toBe(1);

    host.isSelecting.set(true);
    fixture.detectChanges();
    expect(selectBtn.getAttribute('aria-pressed')).toBe('true');
    expect(selectBtn.classList.contains('is-active')).toBe(true);
  });
});
