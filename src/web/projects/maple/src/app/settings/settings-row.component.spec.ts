import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { SettingsRowComponent } from './settings-row.component';

@Component({
  standalone: true,
  imports: [SettingsRowComponent],
  template: `
    <maple-settings-row [expanded]="expanded" (toggle)="expanded = !expanded" testid="t">
      <div class="sum" srow-summary>
        <span class="label">Label</span>
        <button class="inner" type="button">x</button>
      </div>
      <p class="body">Body</p>
    </maple-settings-row>
  `,
})
class HostComponent {
  expanded = false;
}

describe('SettingsRowComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const enterOn = (target: HTMLElement): void => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };

  it('is collapsed by default; clicking the summary toggles it open', () => {
    expect(el().querySelector('.expanded')).toBeNull();
    el().querySelector<HTMLElement>('.row-summary')!.click();
    fixture.detectChanges();
    expect(el().querySelector('.expanded')).not.toBeNull();
  });

  it('does NOT toggle when an interactive child (button) is clicked', () => {
    el().querySelector<HTMLElement>('.inner')!.click();
    fixture.detectChanges();
    expect(el().querySelector('.expanded')).toBeNull();
  });

  it('does NOT toggle on Enter bubbled from a focusable child', () => {
    enterOn(el().querySelector<HTMLElement>('.inner')!);
    fixture.detectChanges();
    expect(el().querySelector('.expanded')).toBeNull();
  });

  it('toggles on Enter when the row summary itself is the target', () => {
    enterOn(el().querySelector<HTMLElement>('.row-summary')!);
    fixture.detectChanges();
    expect(el().querySelector('.expanded')).not.toBeNull();
  });
});
