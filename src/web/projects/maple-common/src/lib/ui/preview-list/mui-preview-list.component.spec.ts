import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPreviewListComponent } from './mui-preview-list.component';

const ITEMS = [
  { id: '1', before: 'IMG_003.NEF', after: 'ballet-003.nef' },
  { id: '2', before: 'IMG_004.NEF', after: 'ballet-004.nef' },
];

function render(): ComponentFixture<MuiPreviewListComponent> {
  TestBed.configureTestingModule({ imports: [MuiPreviewListComponent] });
  const fixture = TestBed.createComponent(MuiPreviewListComponent);
  fixture.componentRef.setInput('items', ITEMS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiPreviewListComponent', () => {
  it('renders one row per item with the before name as the label and after as trailing', () => {
    const fixture = render();
    const rows = fixture.nativeElement.querySelectorAll('.mui-list-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('IMG_003.NEF');
    expect(rows[0].textContent).toContain('ballet-003.nef');
  });

  it('emits pressed with the item id on row press', () => {
    const fixture = render();
    const pressed: string[] = [];
    fixture.componentInstance.pressed.subscribe((id) => pressed.push(id));
    (fixture.nativeElement.querySelectorAll('.mui-list-row')[1] as HTMLElement).click();
    expect(pressed).toEqual(['2']);
  });
});
