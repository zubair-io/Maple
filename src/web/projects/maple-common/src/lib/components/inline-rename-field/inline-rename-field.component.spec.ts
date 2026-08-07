// InlineRenameFieldComponent — spec.
//
// Covers (1) the default stem-only selection / extension-preserved commit,
// (2) the extension-change warning when the user retypes it, (3) Enter/Escape
// keyboard commit+cancel, (4) the error message rendering inline, and
// (5) the collision (Skip/Replace/Keep Both) affordances replacing the input.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { InlineRenameFieldComponent } from './inline-rename-field.component';

function setup(inputs: {
  filename?: string;
  error?: string | null;
  busy?: boolean;
  collision?: boolean;
}) {
  TestBed.configureTestingModule({ imports: [InlineRenameFieldComponent] });
  const fixture = TestBed.createComponent(InlineRenameFieldComponent);
  fixture.componentRef.setInput('filename', inputs.filename ?? 'IMG_0001.CR3');
  if (inputs.error !== undefined) fixture.componentRef.setInput('error', inputs.error);
  if (inputs.busy !== undefined) fixture.componentRef.setInput('busy', inputs.busy);
  if (inputs.collision !== undefined) fixture.componentRef.setInput('collision', inputs.collision);
  fixture.detectChanges();
  return { fixture };
}

describe('InlineRenameFieldComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('seeds the input with the full filename and selects only the stem', () => {
    const { fixture } = setup({ filename: 'IMG_0001.CR3' });
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('IMG_0001.CR3');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('IMG_0001'.length);
  });

  it('emits committed with the full edited value on Enter', () => {
    const { fixture } = setup({ filename: 'IMG_0001.CR3' });
    const cmp = fixture.componentInstance;
    let committedValue: string | undefined;
    cmp.committed.subscribe((v: string) => (committedValue = v));

    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'IMG_0002.CR3';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(committedValue).toBe('IMG_0002.CR3');
  });

  it('emits cancelled on Escape', () => {
    const { fixture } = setup({ filename: 'IMG_0001.CR3' });
    const cmp = fixture.componentInstance;
    let cancelled = false;
    cmp.cancelled.subscribe(() => (cancelled = true));

    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cancelled).toBe(true);
  });

  it('warns when the retyped extension differs from the original, without blocking commit', () => {
    const { fixture } = setup({ filename: 'IMG_0001.CR3' });
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'IMG_0001.jpg';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const warning = fixture.nativeElement.querySelector('.hint-warning');
    expect(warning?.textContent).toMatch(/does not convert/i);
    expect(fixture.componentInstance.extensionChanged()).toBe(true);
  });

  it('shows no warning when the extension is left untouched', () => {
    const { fixture } = setup({ filename: 'IMG_0001.CR3' });
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'IMG_0002.CR3';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.hint-warning')).toBeNull();
    expect(fixture.componentInstance.extensionChanged()).toBe(false);
  });

  it('renders the server error inline next to the field', () => {
    const { fixture } = setup({ filename: 'IMG_0001.CR3', error: 'CON is a reserved name' });
    const error = fixture.nativeElement.querySelector('.hint-error');
    expect(error?.textContent).toContain('CON is a reserved name');
  });

  it('replaces the input with Skip / Replace / Keep Both when a collision is pending', () => {
    const { fixture } = setup({ filename: 'IMG_0001.CR3', collision: true });
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')).map((b) =>
      (b as HTMLElement).textContent?.trim(),
    );
    expect(buttons).toEqual(expect.arrayContaining(['Cancel', 'Keep Both', 'Replace']));
  });

  it('emits collisionResolved("replace") from the Replace button', () => {
    const { fixture } = setup({ filename: 'IMG_0001.CR3', collision: true });
    const cmp = fixture.componentInstance;
    let resolved: string | undefined;
    cmp.collisionResolved.subscribe((v: 'replace' | 'keep-both') => (resolved = v));

    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ) as HTMLButtonElement[];
    const replaceBtn = buttons.find((b) => b.textContent?.trim() === 'Replace');
    replaceBtn?.click();

    expect(resolved).toBe('replace');
  });
});
