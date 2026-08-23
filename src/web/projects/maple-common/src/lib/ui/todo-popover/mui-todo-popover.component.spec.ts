import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiTodoPopoverComponent } from './mui-todo-popover.component';

@Component({
  standalone: true,
  imports: [MuiTodoPopoverComponent],
  template: `
    <div style="position: relative">
      <mui-todo-popover
        [open]="open()"
        title="Ship feature"
        priority="high"
        dueLabel="Fri"
        (closeRequested)="open.set(false)"
        (saved)="savedCount = savedCount + 1"
      />
    </div>
  `,
})
class HostComponent {
  readonly open = signal(true);
  savedCount = 0;
}

function render(): ComponentFixture<HostComponent> {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiTodoPopoverComponent', () => {
  it('renders the task title, priority chips, and due field while open', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.mui-todo-popover')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('High');
  });

  it('renders nothing when closed', () => {
    const fixture = render();
    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-todo-popover')).toBeNull();
  });

  it('Escape requests close via the popover primitive', async () => {
    const fixture = render();
    // mui-popover defers attaching its document listeners by one macrotask
    // (see mui-popover.component.ts) so the click that opened it doesn't
    // immediately close it — wait that same tick out before dispatching.
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('committing the task field emits saved', () => {
    const fixture = render();
    const titleField = fixture.nativeElement.querySelector(
      '.mui-todo-popover mui-form-field .control',
    ) as HTMLInputElement;
    titleField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(fixture.componentInstance.savedCount).toBe(1);
  });
});
