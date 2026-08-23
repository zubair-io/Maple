import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiFilmstripRowComponent } from './mui-filmstrip-row.component';

const ITEMS = [
  { id: '1', src: 'a.jpg', alt: 'A' },
  { id: '2', src: 'b.jpg', alt: 'B' },
  { id: '3', src: 'c.jpg', alt: 'C' },
];

function render(): ComponentFixture<MuiFilmstripRowComponent> {
  TestBed.configureTestingModule({ imports: [MuiFilmstripRowComponent] });
  const fixture = TestBed.createComponent(MuiFilmstripRowComponent);
  fixture.componentRef.setInput('items', ITEMS);
  fixture.componentRef.setInput('activeId', '1');
  fixture.detectChanges();
  return fixture;
}

describe('MuiFilmstripRowComponent', () => {
  it('renders one media cell per item and marks the active one selected', () => {
    const fixture = render();
    const cells = fixture.nativeElement.querySelectorAll('.cell');
    expect(cells.length).toBe(3);
    expect(cells[0].querySelector('.mui-media-cell').className).toContain('is-selected');
    expect(cells[1].querySelector('.mui-media-cell').className).not.toContain('is-selected');
  });

  it('clicking a cell moves activeId to follow it and emits activated', () => {
    const fixture = render();
    const activated: string[] = [];
    fixture.componentInstance.activated.subscribe((id) => activated.push(id));

    (
      fixture.nativeElement
        .querySelectorAll('.cell')[2]
        .querySelector('.mui-media-cell') as HTMLElement
    ).click();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeId()).toBe('3');
    expect(activated).toEqual(['3']);
    expect(
      fixture.nativeElement.querySelectorAll('.cell')[2].querySelector('.mui-media-cell').className,
    ).toContain('is-selected');
  });
});
