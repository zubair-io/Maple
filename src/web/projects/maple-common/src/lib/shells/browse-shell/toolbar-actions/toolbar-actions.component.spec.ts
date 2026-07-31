// ToolbarActionsComponent — extracted from BrowseShellComponent (#2293
// fallow-audit-web fix). Covers the desktop inline-row vs collapsed-kebab
// presentation, the self-hosted gating on Edit Metadata / Merge to
// panorama, and that every pill emits its own output.

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
      [selfHosted]="selfHosted()"
      [canEditMetadata]="canEditMetadata()"
      [canMergePano]="canMergePano()"
      [canCopySettings]="canCopySettings()"
      [canPasteSettings]="canPasteSettings()"
      [canSyncSettings]="canSyncSettings()"
      [selectedCount]="selectedCount()"
      (editMetadata)="editMetadataCount.update((v) => v + 1)"
      (mergePano)="mergePanoCount.update((v) => v + 1)"
      (copySettings)="copySettingsCount.update((v) => v + 1)"
      (openPasteDialog)="openPasteDialogCount.update((v) => v + 1)"
      (syncSettings)="syncSettingsCount.update((v) => v + 1)"
    />
  `,
})
class HostComponent {
  readonly collapsed = signal(false);
  readonly selfHosted = signal(true);
  readonly canEditMetadata = signal(false);
  readonly canMergePano = signal(false);
  readonly canCopySettings = signal(false);
  readonly canPasteSettings = signal(false);
  readonly canSyncSettings = signal(false);
  readonly selectedCount = signal(0);

  readonly editMetadataCount = signal(0);
  readonly mergePanoCount = signal(0);
  readonly copySettingsCount = signal(0);
  readonly openPasteDialogCount = signal(0);
  readonly syncSettingsCount = signal(0);
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

  it('gates Edit Metadata and Merge to panorama on selfHosted', () => {
    host.selfHosted.set(false);
    fixture.detectChanges();
    expect(el().querySelector('[aria-label="Edit metadata"]')).toBeNull();
    expect(el().querySelector('[aria-label="Merge to panorama"]')).toBeNull();
    // Copy/Paste/Sync/Export stay visible — not backend-gated.
    expect(el().querySelector('[aria-label="Copy settings"]')).not.toBeNull();

    host.selfHosted.set(true);
    fixture.detectChanges();
    expect(el().querySelector('[aria-label="Edit metadata"]')).not.toBeNull();
    expect(el().querySelector('[aria-label="Merge to panorama"]')).not.toBeNull();
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

  it('emits editMetadata / mergePano / openPasteDialog / syncSettings from their own pills', () => {
    host.canEditMetadata.set(true);
    host.canMergePano.set(true);
    host.canPasteSettings.set(true);
    host.canSyncSettings.set(true);
    fixture.detectChanges();

    (el().querySelector('[aria-label="Edit metadata"]') as HTMLButtonElement).click();
    (el().querySelector('[aria-label="Merge to panorama"]') as HTMLButtonElement).click();
    (el().querySelector('[aria-label="Paste settings"]') as HTMLButtonElement).click();
    (el().querySelector('[aria-label="Sync settings"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(host.editMetadataCount()).toBe(1);
    expect(host.mergePanoCount()).toBe(1);
    expect(host.openPasteDialogCount()).toBe(1);
    expect(host.syncSettingsCount()).toBe(1);
  });

  it('disables pills whose gating input is false and shows the selection count when true', () => {
    host.canCopySettings.set(false);
    host.selectedCount.set(3);
    fixture.detectChanges();

    const copyBtn = el().querySelector('[aria-label="Copy settings"]') as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);

    const exportBtn = el().querySelector('.export-btn.has-selection') as HTMLButtonElement | null;
    expect(exportBtn?.textContent).toContain('Export (3)');
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
});
