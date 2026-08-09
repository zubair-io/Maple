import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { TrashNodeRowComponent } from './trash-node-row.component';

describe('TrashNodeRowComponent', () => {
  function setup(badge: string | null = null) {
    const fixture = TestBed.createComponent(TrashNodeRowComponent);
    fixture.componentRef.setInput('libraryLabel', 'Photos');
    fixture.componentRef.setInput('badge', badge);
    fixture.detectChanges();
    return fixture;
  }

  it('renders the Trash label and an accessible aria-label', () => {
    const fixture = setup();
    const row: HTMLElement = fixture.nativeElement.querySelector('[role="treeitem"]');
    expect(row.getAttribute('aria-label')).toBe('Trash — Photos');
    expect(row.textContent).toContain('Trash');
  });

  it('renders no badge when count is null', () => {
    const fixture = setup(null);
    expect(fixture.nativeElement.textContent).not.toMatch(/\d/);
  });

  it('renders the badge text when provided', () => {
    const fixture = setup('12');
    expect(fixture.nativeElement.textContent).toContain('12');
  });

  it('emits activate on click', () => {
    const fixture = setup();
    let activated = false;
    fixture.componentInstance.activate.subscribe(() => (activated = true));
    const row: HTMLElement = fixture.nativeElement.querySelector('[role="treeitem"]');
    row.click();
    expect(activated).toBe(true);
  });

  it('emits activate on Enter and Space keydown', () => {
    const fixture = setup();
    let count = 0;
    fixture.componentInstance.activate.subscribe(() => (count += 1));
    const row: HTMLElement = fixture.nativeElement.querySelector('[role="treeitem"]');
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(count).toBe(2);
  });

  it('is keyboard-focusable', () => {
    const fixture = setup();
    const row: HTMLElement = fixture.nativeElement.querySelector('[role="treeitem"]');
    expect(row.getAttribute('tabindex')).toBe('0');
  });
});
