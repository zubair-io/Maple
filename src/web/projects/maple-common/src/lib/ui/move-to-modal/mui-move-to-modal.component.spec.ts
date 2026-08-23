import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiMoveToTreeNode } from './mui-move-to-modal.component';
import { MuiMoveToModalComponent } from './mui-move-to-modal.component';

const NODES: readonly MuiMoveToTreeNode[] = [
  { id: 'root', parentId: null, name: '2026 Client Work', depth: 0, hasChildren: true },
  { id: 'child', parentId: 'root', name: 'Ballet Session', depth: 1, hasChildren: false },
  { id: 'other', parentId: null, name: 'Personal', depth: 0, hasChildren: false },
];

@Component({
  standalone: true,
  imports: [MuiMoveToModalComponent],
  template: `
    <mui-move-to-modal
      [open]="open()"
      [nodes]="nodes"
      [(selectedId)]="selectedId"
      (moveConfirmed)="onMoveConfirmed($event)"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly nodes = NODES;
  readonly selectedId = signal<string | null>(null);
  dismissedCount = 0;
  lastMoveId: string | null = null;

  onMoveConfirmed(id: string): void {
    this.lastMoveId = id;
  }
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiMoveToModalComponent', () => {
  it('only shows root nodes until their parent is expanded', () => {
    const { fixture } = render();
    const rows = fixture.nativeElement.querySelectorAll('mui-tree-row');
    expect(rows.length).toBe(2);
    expect(fixture.nativeElement.textContent).not.toContain('Ballet Session');
  });

  it('expanding a node reveals its children', () => {
    const { fixture } = render();
    const chevron = fixture.nativeElement.querySelector(
      'mui-tree-row .chevron',
    ) as HTMLButtonElement;
    chevron.click();
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('mui-tree-row');
    expect(rows.length).toBe(3);
    expect(fixture.nativeElement.textContent).toContain('Ballet Session');
  });

  it('typing in the search bar filters the tree by name regardless of expand state', () => {
    const { fixture } = render();
    const input = fixture.nativeElement.querySelector(
      'mui-search-bar .control',
    ) as HTMLInputElement;
    input.value = 'ballet';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('mui-tree-row');
    expect(rows.length).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('Ballet Session');
  });

  it('clearing the search restores the collapsed tree view', () => {
    const { fixture } = render();
    const input = fixture.nativeElement.querySelector(
      'mui-search-bar .control',
    ) as HTMLInputElement;
    input.value = 'ballet';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    input.value = '';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('mui-tree-row');
    expect(rows.length).toBe(2);
  });

  it('selecting a row and pressing Move emits the destination id', () => {
    const { fixture, host } = render();
    const rows = fixture.nativeElement.querySelectorAll('mui-tree-row .mui-tree-row');
    (rows[1] as HTMLElement).click();
    fixture.detectChanges();
    expect(host.selectedId()).toBe('other');

    const moveButton = fixture.nativeElement.querySelectorAll(
      '.mui-move-to-modal-footer button',
    )[1] as HTMLButtonElement;
    expect(moveButton.disabled).toBe(false);
    moveButton.click();
    expect(host.lastMoveId).toBe('other');
  });

  it('disables Move until a destination is selected', () => {
    const { fixture } = render();
    const moveButton = fixture.nativeElement.querySelectorAll(
      '.mui-move-to-modal-footer button',
    )[1] as HTMLButtonElement;
    expect(moveButton.disabled).toBe(true);
  });
});
