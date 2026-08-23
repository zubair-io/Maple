import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiFilmstripRailComponent } from './mui-filmstrip-rail.component';

const ITEMS = [
  { id: '1', src: 'a.jpg', alt: 'A' },
  { id: '2', src: 'b.jpg', alt: 'B' },
];

function render(): ComponentFixture<MuiFilmstripRailComponent> {
  TestBed.configureTestingModule({ imports: [MuiFilmstripRailComponent] });
  const fixture = TestBed.createComponent(MuiFilmstripRailComponent);
  fixture.componentRef.setInput('items', ITEMS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiFilmstripRailComponent', () => {
  it('renders expanded by default with one cell per item', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelectorAll('.cell').length).toBe(2);
  });

  it('the toggle button collapses and expands the rail', () => {
    const fixture = render();
    const toggle = fixture.nativeElement.querySelector('.toggle') as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.collapsed()).toBe(true);
    expect(fixture.nativeElement.querySelector('.cells')).toBeNull();

    toggle.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.collapsed()).toBe(false);
    expect(fixture.nativeElement.querySelector('.cells')).toBeTruthy();
  });

  it('selecting a cell updates activeId and emits activated', () => {
    const fixture = render();
    const activated: string[] = [];
    fixture.componentInstance.activated.subscribe((id) => activated.push(id));

    (
      fixture.nativeElement
        .querySelectorAll('.cell')[1]
        .querySelector('.mui-media-cell') as HTMLElement
    ).click();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeId()).toBe('2');
    expect(activated).toEqual(['2']);
  });
});
