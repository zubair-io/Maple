import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ExportDialogComponent } from './export-dialog.component';
import { ImageExportService } from './image-export.service';

async function setup() {
  const exporter = { exportAsset: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [ExportDialogComponent],
    providers: [{ provide: ImageExportService, useValue: exporter }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ExportDialogComponent);
  const dismiss = vi.fn();
  fixture.componentInstance.dismiss.subscribe(dismiss);
  return { fixture, dismiss };
}

describe('ExportDialogComponent accessibility', () => {
  it('moves focus into the modal and restores its trigger when dismissed', async () => {
    const { fixture } = await setup();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve));
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.export-close'));

    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('consumes Escape so the editor cannot navigate behind the modal', async () => {
    const { fixture, dismiss } = await setup();
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stopPropagation = vi.spyOn(event, 'stopPropagation');

    fixture.nativeElement.querySelector('[role="dialog"]').dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('consumes but does not dismiss Escape while an export is running', async () => {
    const { fixture, dismiss } = await setup();
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    fixture.componentInstance.phase.set('exporting');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stopPropagation = vi.spyOn(event, 'stopPropagation');

    fixture.nativeElement.querySelector('[role="dialog"]').dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('wraps links while skipping native controls removed from the tab order', async () => {
    const { fixture } = await setup();
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement;
    const link = document.createElement('a');
    link.href = '#export-help';
    const excluded = document.createElement('button');
    excluded.tabIndex = -1;
    dialog.append(link, excluded);
    link.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });

    dialog.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog.querySelector('.export-close'));
  });
});
