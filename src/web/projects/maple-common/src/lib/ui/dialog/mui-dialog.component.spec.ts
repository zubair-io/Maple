import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiDialogComponent } from './mui-dialog.component';

function render(): ComponentFixture<MuiDialogComponent> {
  TestBed.configureTestingModule({ imports: [MuiDialogComponent] });
  const fixture = TestBed.createComponent(MuiDialogComponent);
  fixture.componentRef.setInput('title', 'Delete page?');
  fixture.componentRef.setInput('open', true);
  fixture.detectChanges();
  return fixture;
}

describe('MuiDialogComponent', () => {
  it('renders nothing when closed', () => {
    const fixture = render();
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-dialog-scrim')).toBeNull();
  });

  it('emits confirmed with the prompt value on Confirm', () => {
    const fixture = render();
    fixture.componentRef.setInput('variant', 'prompt');
    fixture.componentRef.setInput('promptValue', 'Renamed roll');
    fixture.detectChanges();

    const confirmed: string[] = [];
    fixture.componentInstance.confirmed.subscribe((v) => confirmed.push(v));
    const buttons = fixture.nativeElement.querySelectorAll('.actions button');
    (buttons[1] as HTMLButtonElement).click();
    expect(confirmed).toEqual(['Renamed roll']);
  });

  it('emits dismissed on Cancel click, scrim click, and Escape', () => {
    const fixture = render();
    let dismissedCount = 0;
    fixture.componentInstance.dismissed.subscribe(() => dismissedCount++);

    const buttons = fixture.nativeElement.querySelectorAll('.actions button');
    (buttons[0] as HTMLButtonElement).click();
    expect(dismissedCount).toBe(1);

    (fixture.nativeElement.querySelector('.mui-dialog-scrim') as HTMLElement).click();
    expect(dismissedCount).toBe(2);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dismissedCount).toBe(3);
  });

  it('clicking inside the panel does not dismiss (scrim-only outside click)', () => {
    const fixture = render();
    let dismissedCount = 0;
    fixture.componentInstance.dismissed.subscribe(() => dismissedCount++);
    (fixture.nativeElement.querySelector('.mui-dialog') as HTMLElement).click();
    expect(dismissedCount).toBe(0);
  });

  it('omits the prompt input for the confirm variant', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.mui-dialog mui-input')).toBeNull();
  });
});
