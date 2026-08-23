import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiFilmstripComponent } from './mui-filmstrip.component';
import type { MuiFilmstripItem } from '../filmstrip-row/mui-filmstrip-row.component';

const ITEMS: readonly MuiFilmstripItem[] = [
  { id: 'a', src: 'a.png', alt: 'A' },
  { id: 'b', src: 'b.png', alt: 'B' },
];

function render(): ComponentFixture<MuiFilmstripComponent> {
  TestBed.configureTestingModule({ imports: [MuiFilmstripComponent] });
  const fixture = TestBed.createComponent(MuiFilmstripComponent);
  fixture.componentRef.setInput('items', ITEMS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiFilmstripComponent', () => {
  it('renders Filmstrip Row for horizontal orientation (the default)', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-filmstrip-row')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-filmstrip-rail')).toBeNull();
  });

  it('renders Filmstrip Rail for vertical orientation', () => {
    const fixture = render();
    fixture.componentRef.setInput('orientation', 'vertical');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-filmstrip-rail')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-filmstrip-row')).toBeNull();
  });

  it('activeId two-way binds through to the active child and back out via activated', () => {
    const fixture = render();
    const activated: string[] = [];
    fixture.componentInstance.activated.subscribe((id) => activated.push(id));

    const cell = fixture.nativeElement.querySelector(
      'mui-filmstrip-row mui-media-cell .mui-media-cell',
    );
    (cell as HTMLElement).click();
    fixture.detectChanges();

    expect(activated).toEqual(['a']);
    expect(fixture.componentInstance.activeId()).toBe('a');
  });

  it('collapsed is forwarded to the rail in vertical orientation', () => {
    const fixture = render();
    fixture.componentRef.setInput('orientation', 'vertical');
    fixture.componentRef.setInput('collapsed', true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement
        .querySelector('mui-filmstrip-rail .mui-filmstrip-rail')
        .classList.contains('is-collapsed'),
    ).toBe(true);
  });
});
