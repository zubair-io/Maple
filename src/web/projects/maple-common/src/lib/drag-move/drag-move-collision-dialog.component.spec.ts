// drag-move-collision-dialog.component.spec.ts — new coverage added
// alongside the MW2 (#3029) raw-`<button>` → `<mui-button>` migration
// (dmc-btn-* deleted). Skip/Replace/Keep Both had no test coverage before
// this; the DOM-shaped assertions below key off `mui-button`'s rendered
// classes since the component itself no longer owns any button markup.

import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { DragMoveCollisionPolicy } from './drag-move-capability';
import { DragMoveCollisionDialogComponent } from './drag-move-collision-dialog.component';

function render(): ComponentFixture<DragMoveCollisionDialogComponent> {
  TestBed.configureTestingModule({ imports: [DragMoveCollisionDialogComponent] });
  const fixture = TestBed.createComponent(DragMoveCollisionDialogComponent);
  fixture.componentRef.setInput('filename', 'photo.dng');
  fixture.detectChanges();
  return fixture;
}

function buttons(fixture: ComponentFixture<DragMoveCollisionDialogComponent>): HTMLButtonElement[] {
  return Array.from(fixture.nativeElement.querySelectorAll('.dmc-footer button'));
}

describe('DragMoveCollisionDialogComponent', () => {
  it('names the file in the message', () => {
    const fixture = render();
    expect(fixture.nativeElement.textContent).toContain('photo.dng');
  });

  it('emits resolve with the policy for Skip, Keep Both, and Replace', () => {
    const fixture = render();
    const resolved: DragMoveCollisionPolicy[] = [];
    fixture.componentInstance.resolve.subscribe((policy) => resolved.push(policy));

    const [skip, keepBoth, replace] = buttons(fixture);
    skip.click();
    keepBoth.click();
    replace.click();

    expect(resolved).toEqual(['skip', 'keep-both', 'replace']);
  });

  it('a backdrop click resolves as skip (the non-destructive default)', () => {
    const fixture = render();
    const resolved: DragMoveCollisionPolicy[] = [];
    fixture.componentInstance.resolve.subscribe((policy) => resolved.push(policy));

    (fixture.nativeElement.querySelector('.dmc-backdrop') as HTMLElement).click();

    expect(resolved).toEqual(['skip']);
  });

  it('focuses the Skip button once the view is up', async () => {
    const fixture = render();
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(document.activeElement).toBe(buttons(fixture)[0]);
  });
});
