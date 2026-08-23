import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiCardDetailModalComponent } from './mui-card-detail-modal.component';
import type { MuiCardDetailData } from './mui-card-detail-modal.component';

@Component({
  standalone: true,
  imports: [MuiCardDetailModalComponent],
  template: `
    <mui-card-detail-modal
      [open]="open()"
      [(title)]="title"
      [(selectedPriority)]="priority"
      [(body)]="body"
      (saved)="lastSaved = $event"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly title = signal('Fix the header layout');
  readonly priority = signal<string | null>(null);
  readonly body = signal('Initial notes');
  lastSaved: MuiCardDetailData | null = null;
  dismissedCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiCardDetailModalComponent', () => {
  it('writes the initial body into the contenteditable region on open', () => {
    const { fixture } = render();
    const editor = (fixture.nativeElement as HTMLElement).querySelector(
      '.body-editor',
    ) as HTMLDivElement;
    expect(editor.textContent).toBe('Initial notes');
  });

  it('syncs typed edits back into the body model', () => {
    const { fixture, host } = render();
    const editor = (fixture.nativeElement as HTMLElement).querySelector(
      '.body-editor',
    ) as HTMLDivElement;
    editor.textContent = 'Updated notes';
    editor.dispatchEvent(new Event('input'));
    expect(host.body()).toBe('Updated notes');
  });

  it('selects a priority chip and includes it in the saved payload', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    const highChip = Array.from(el.querySelectorAll('.chip')).find((chip) =>
      chip.textContent?.includes('High'),
    ) as HTMLButtonElement;
    highChip.click();
    fixture.detectChanges();
    expect(host.priority()).toBe('high');

    const saveBtn = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save',
    ) as HTMLButtonElement;
    saveBtn.click();

    expect(host.lastSaved).toEqual({
      title: 'Fix the header layout',
      priority: 'high',
      body: 'Initial notes',
    });
  });

  it('disables Save when the title is blank', () => {
    const { fixture, host } = render();
    host.title.set('   ');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const saveBtn = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('emits dismissed on scrim click', () => {
    const { fixture, host } = render();
    (fixture.nativeElement.querySelector('.mui-overlay-shell-scrim') as HTMLElement).click();
    expect(host.dismissedCount).toBe(1);
  });
});
