import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiFilmPanelComponent } from './mui-film-panel.component';

const CATEGORIES = [
  { id: 'color', label: 'Color' },
  { id: 'bw', label: 'B&W' },
];

const LOOKS = [
  { id: 'kodak', name: 'Kodak Gold', src: '/looks/kodak.jpg', category: 'color' },
  { id: 'portra', name: 'Portra 400', src: '/looks/portra.jpg', category: 'color' },
  { id: 'trix', name: 'Tri-X 400', src: '/looks/trix.jpg', category: 'bw' },
];

function render(): ComponentFixture<MuiFilmPanelComponent> {
  TestBed.configureTestingModule({ imports: [MuiFilmPanelComponent] });
  const fixture = TestBed.createComponent(MuiFilmPanelComponent);
  fixture.componentRef.setInput('categories', CATEGORIES);
  fixture.componentRef.setInput('looks', LOOKS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiFilmPanelComponent', () => {
  it('shows all looks with no category filter row when categories is empty', () => {
    TestBed.configureTestingModule({ imports: [MuiFilmPanelComponent] });
    const fixture = TestBed.createComponent(MuiFilmPanelComponent);
    fixture.componentRef.setInput('looks', LOOKS);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-chip-row')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.look-cell').length).toBe(3);
  });

  it('selecting a category chip narrows the visible looks', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelectorAll('.look-cell').length).toBe(3);

    const chips = fixture.nativeElement.querySelectorAll('mui-chip-row .chip');
    (chips[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeCategoryId()).toBe('bw');
    const cells = fixture.nativeElement.querySelectorAll('.look-cell');
    expect(cells.length).toBe(1);
    expect(fixture.componentInstance.visibleLooks().map((look) => look.id)).toEqual(['trix']);
  });

  it('clicking a look card selects it and highlights the cell', () => {
    const fixture = render();
    const cells = fixture.nativeElement.querySelectorAll('.look-cell');
    (cells[0].querySelector('.mui-card') as HTMLElement).click();
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedLookId()).toBe('kodak');
    expect(cells[0].classList.contains('is-selected')).toBe(true);
    expect(cells[1].classList.contains('is-selected')).toBe(false);
  });

  it('double-clicking a look cell emits looksApplied with its id', () => {
    const fixture = render();
    const applied: string[] = [];
    fixture.componentInstance.looksApplied.subscribe((id) => applied.push(id));

    const cells = fixture.nativeElement.querySelectorAll('.look-cell');
    cells[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(applied).toEqual(['portra']);
  });

  it('shows the strength slider only once a look is selected', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-living-slider')).toBeNull();

    const cells = fixture.nativeElement.querySelectorAll('.look-cell');
    (cells[0].querySelector('.mui-card') as HTMLElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-living-slider')).not.toBeNull();
  });

  it('shows an empty state when there are no looks', () => {
    TestBed.configureTestingModule({ imports: [MuiFilmPanelComponent] });
    const fixture = TestBed.createComponent(MuiFilmPanelComponent);
    fixture.componentRef.setInput('looks', []);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-empty-state')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.look-cell')).toBeNull();
  });
});
