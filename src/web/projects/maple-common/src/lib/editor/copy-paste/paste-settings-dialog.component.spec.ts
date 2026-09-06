import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { PasteSettingsDialogComponent } from './paste-settings-dialog.component';
import { defaultAdjustmentModel } from '../../models/adjustment-model';

describe('selective paste preview', () => {
  it('waits for target reads, renders actual values and keeps group toggles while previewing', () => {
    TestBed.configureTestingModule({ imports: [PasteSettingsDialogComponent] });
    const fixture = TestBed.createComponent(PasteSettingsDialogComponent);
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('sourceLabel', 'source.jpg');
    fixture.componentRef.setInput('sourceModel', { ...defaultAdjustmentModel(), exposure: 1.25 });
    fixture.componentRef.setInput('targetCount', 2);
    fixture.detectChanges();
    const paste = () =>
      fixture.nativeElement.querySelector(
        '.mui-selective-paste-modal-footer mui-button:last-child button',
      ) as HTMLButtonElement;
    expect(paste().disabled).toBe(true);
    fixture.componentRef.setInput('targetModels', [
      defaultAdjustmentModel(),
      { ...defaultAdjustmentModel(), exposure: -2 },
    ]);
    fixture.detectChanges();
    expect(paste().disabled).toBe(false);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Exposure');
    expect(text).toContain('Mixed: 0, -2');
    expect(text).toContain('1.25');
    expect(text).toContain('2 changed');
    const input = fixture.nativeElement.querySelector('mui-checkbox input') as HTMLInputElement;
    input.checked = false;
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(input.checked).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('1.25');
  });

  it('refuses confirmation when reading a sidecar failed', () => {
    TestBed.configureTestingModule({ imports: [PasteSettingsDialogComponent] });
    const fixture = TestBed.createComponent(PasteSettingsDialogComponent);
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('sourceModel', defaultAdjustmentModel());
    fixture.componentRef.setInput('previewError', 'Could not read current settings');
    fixture.detectChanges();
    let emitted = false;
    fixture.componentInstance.paste.subscribe(() => {
      emitted = true;
    });
    fixture.componentInstance.onPasteConfirmed(['tone']);
    expect(emitted).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Could not read current settings');
  });
});
