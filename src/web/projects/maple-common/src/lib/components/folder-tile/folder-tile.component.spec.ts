import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { FolderTileComponent } from './folder-tile.component';
import type { GridFolderItem } from '../../models/folder';

function makeFolder(name = 'Vacation 2026'): GridFolderItem {
  return { id: 'lib:vacation', name, parentSourceId: 'lib', aspectRatio: 1 };
}

function render(): ComponentFixture<FolderTileComponent> {
  TestBed.configureTestingModule({ imports: [FolderTileComponent] });
  const fixture = TestBed.createComponent(FolderTileComponent);
  fixture.componentRef.setInput('folder', makeFolder());
  fixture.detectChanges();
  return fixture;
}

function root(fixture: ComponentFixture<FolderTileComponent>): HTMLElement {
  return fixture.nativeElement.querySelector('.folder-tile') as HTMLElement;
}

describe('FolderTileComponent', () => {
  it('renders the folder icon and name', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-icon')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Vacation 2026');
  });

  it('is a role="button" with keyboard focus support (tabindex 0)', () => {
    const fixture = render();
    const el = root(fixture);
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('emits folderClick on click', () => {
    const fixture = render();
    let received: MouseEvent | undefined;
    fixture.componentInstance.folderClick.subscribe((e) => (received = e));
    root(fixture).click();
    expect(received).toBeInstanceOf(MouseEvent);
  });

  it('emits folderDblClick on dblclick, independent of folderClick', () => {
    const fixture = render();
    let dblCount = 0;
    fixture.componentInstance.folderDblClick.subscribe(() => dblCount++);
    root(fixture).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(dblCount).toBe(1);
  });

  it('Enter/Space activates the tile the same as a click (new keyboard affordance)', () => {
    const fixture = render();
    let clickCount = 0;
    fixture.componentInstance.folderClick.subscribe(() => clickCount++);
    root(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(clickCount).toBe(1);
    root(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(clickCount).toBe(2);
  });

  it('reflects selection via the selected class and aria-pressed', () => {
    const fixture = render();
    const el = root(fixture);
    expect(el.classList.contains('selected')).toBe(false);
    expect(el.getAttribute('aria-pressed')).toBe('false');

    fixture.componentRef.setInput('selected', true);
    fixture.detectChanges();
    expect(el.classList.contains('selected')).toBe(true);
    expect(el.getAttribute('aria-pressed')).toBe('true');
  });

  it('contains the folder-ring overlay the selection/focus-visible CSS lights', () => {
    const fixture = render();
    expect(root(fixture).querySelector('.folder-ring')).toBeTruthy();
  });
});
