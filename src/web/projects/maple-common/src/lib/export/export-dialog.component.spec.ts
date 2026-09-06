// export-dialog.component.spec.ts — the wrapper's own remaining
// responsibility after #3046: the format/color-space/size view-model
// (choice tables + live blurbs) and running the actual export against
// `ImageExportService` through the 4-phase state machine. Focus-on-open,
// Escape, Tab containment, and scrim-click dismiss are no longer this
// file's concern — `mui-overlay-shell` (which `mui-export-modal` is built
// on) owns all of that generically now, and is covered by its own spec
// (`mui-overlay-shell.component.spec.ts`); the busy-guard that used to
// block Escape/scrim-click mid-export is covered by
// `mui-export-modal.component.spec.ts`'s "exporting phase … suppresses"
// test.

import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ExportDialogComponent } from './export-dialog.component';
import { ImageExportService } from './image-export.service';
import type { Asset } from '../models/asset';

async function setup(
  exportResult?: unknown,
  deferBlockBehavior = DeferBlockBehavior.Playthrough,
  visible = true,
) {
  const exporter = {
    exportAsset: vi.fn(() =>
      exportResult === undefined
        ? Promise.resolve({ filename: 'a.jpg', width: 4000, height: 3000, byteLength: 123 })
        : Promise.reject(exportResult),
    ),
  };
  await TestBed.configureTestingModule({
    imports: [ExportDialogComponent],
    deferBlockBehavior,
    providers: [{ provide: ImageExportService, useValue: exporter }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ExportDialogComponent);
  const dismiss = vi.fn();
  fixture.componentInstance.dismiss.subscribe(dismiss);
  const asset = { id: 'a', filename: 'a.dng', width: 4000, height: 3000 } as Asset;
  fixture.componentRef.setInput('asset', asset);
  fixture.componentRef.setInput('visible', visible);
  fixture.detectChanges();
  return { fixture, dismiss, exporter, asset };
}

function exportButton(fixture: { nativeElement: Element }): HTMLButtonElement {
  const buttons = Array.from(
    fixture.nativeElement.querySelectorAll('.mui-export-modal-footer button'),
  ) as HTMLButtonElement[];
  return buttons.find((b) => b.textContent?.trim() === 'Export')!;
}

describe('ExportDialogComponent', () => {
  it('loads the options on first open and keeps the selected format when reopened', async () => {
    const { fixture } = await setup(undefined, DeferBlockBehavior.Playthrough, false);
    expect(fixture.nativeElement.querySelector('mui-export-modal')).toBeNull();

    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(exportButton(fixture)).toBeDefined();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBe(document.activeElement);

    fixture.componentInstance.onFormatChange('tiff');
    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    expect(fixture.componentInstance.format()).toBe('tiff');
    expect(fixture.nativeElement.querySelectorAll('mui-segmented-toggle').length).toBe(3);
  });

  it('allows cancelling a slow load and does not reopen after the chunk arrives', async () => {
    const { fixture, dismiss, exporter } = await setup(undefined, DeferBlockBehavior.Manual);
    fixture.componentInstance.dismiss.subscribe(() => {
      fixture.componentRef.setInput('visible', false);
    });
    const [block] = await fixture.getDeferBlocks();
    await block.render(DeferBlockState.Loading);
    expect(fixture.nativeElement.querySelector('[role="status"]').textContent).toContain('Loading');
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(dismiss).toHaveBeenCalledOnce();

    await block.render(DeferBlockState.Complete);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    expect(exporter.exportAsset).not.toHaveBeenCalled();
  });

  it('reports a failed chunk load in a dismissible dialog', async () => {
    const { fixture, dismiss } = await setup(undefined, DeferBlockBehavior.Manual);
    const [block] = await fixture.getDeferBlocks();
    await block.render(DeferBlockState.Error);
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'Could not load export options',
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('includes the value-0 "Full resolution" sentinel the modal contract requires', async () => {
    const { fixture } = await setup();
    const options = fixture.componentInstance.sizeOptions;
    expect(options[0]).toEqual({ value: 0, label: 'Full resolution' });
    expect(options.length).toBeGreaterThan(1);
  });

  it('renders the mui-export-modal open with the format/color-space/size choice tables', async () => {
    const { fixture } = await setup();
    expect(fixture.nativeElement.querySelector('mui-overlay-shell')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('mui-segmented-toggle').length).toBe(3);
  });

  it('formatDetail and qualityVisible update live as the user changes the format picker', async () => {
    const { fixture } = await setup();
    // JPEG (default): quality field visible, JPEG's own blurb shown.
    expect(fixture.nativeElement.querySelector('mui-form-field')).not.toBeNull();
    expect(fixture.componentInstance.formatDetail()).toContain('compressed');

    fixture.componentInstance.onFormatChange('tiff');
    fixture.detectChanges();

    expect(fixture.componentInstance.qualityVisible()).toBe(false);
    expect(fixture.nativeElement.querySelector('mui-form-field')).toBeNull();
    expect(fixture.componentInstance.formatDetail()).toContain('lossless');
  });

  it('a successful export routes through ImageExportService and lands on the done phase', async () => {
    const { fixture, exporter, asset } = await setup();

    exportButton(fixture).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.phase()).toBe('exporting');
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(exporter.exportAsset).toHaveBeenCalledWith(
      asset,
      expect.objectContaining({ format: 'jpeg', colorSpace: 'srgb' }),
    );
    expect(fixture.componentInstance.phase()).toBe('done');
    expect(fixture.componentInstance.doneMessage()).toBe('Exported a.jpg');
    expect(fixture.componentInstance.outcomeSize()).toBe('4000 × 3000 px');
  });

  it('a failed export lands on the error phase with the failure message, and Retry returns to options', async () => {
    const { fixture } = await setup(new Error('Disk full'));

    exportButton(fixture).click();
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.componentInstance.phase()).toBe('error');
    expect(fixture.componentInstance.errorMessage()).toBe('Disk full');

    fixture.componentInstance.onRetry();
    fixture.detectChanges();
    expect(fixture.componentInstance.phase()).toBe('options');
    expect(fixture.componentInstance.errorMessage()).toBe('');
  });

  it('opening the dialog resets a previous run’s phase/error/outcome', async () => {
    const { fixture } = await setup(new Error('boom'));
    exportButton(fixture).click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(fixture.componentInstance.phase()).toBe('error');

    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();

    expect(fixture.componentInstance.phase()).toBe('options');
    expect(fixture.componentInstance.errorMessage()).toBe('');
    expect(fixture.componentInstance.outcome()).toBeNull();
  });

  it('disables Export when there is no asset, and emits dismiss on Cancel', async () => {
    const { fixture, dismiss } = await setup();
    fixture.componentRef.setInput('asset', null);
    fixture.detectChanges();
    expect(exportButton(fixture).disabled).toBe(true);

    const cancel = Array.from(
      fixture.nativeElement.querySelectorAll('.mui-export-modal-footer button'),
    ).find((b) => (b as HTMLButtonElement).textContent?.trim() === 'Cancel') as HTMLButtonElement;
    cancel.click();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
