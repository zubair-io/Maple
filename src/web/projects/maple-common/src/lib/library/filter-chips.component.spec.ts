// filter-chips.component.spec.ts — S2 (#623). Single-select pill row
// renders four chips, highlights the active one, and emits
// `filterChange` on tap.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { FilterChipsComponent } from './filter-chips.component';
import { CullFilter } from '../state/browse-preferences.service';

@Component({
  standalone: true,
  imports: [FilterChipsComponent],
  template: ` <app-filter-chips [active]="active()" (filterChange)="onChange($event)" /> `,
})
class HostComponent {
  active = signal<CullFilter>('all');
  changes: CullFilter[] = [];
  onChange(v: CullFilter): void {
    this.changes.push(v);
  }
}

describe('FilterChipsComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function chips(): NodeListOf<HTMLButtonElement> {
    return fixture.nativeElement.querySelectorAll('button.chip');
  }

  it('renders four chips with the spec labels', () => {
    const buttons = Array.from(chips());
    expect(buttons.length).toBe(4);
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      'All',
      'Picks',
      '4+ stars',
      'Edited',
    ]);
  });

  it('marks the active chip with .active and aria-selected="true"', () => {
    host.active.set('picks');
    fixture.detectChanges();
    const buttons = Array.from(chips());
    expect(buttons[0].classList.contains('active')).toBe(false);
    expect(buttons[1].classList.contains('active')).toBe(true);
    expect(buttons[1].getAttribute('aria-selected')).toBe('true');
    expect(buttons[0].getAttribute('aria-selected')).toBe('false');
  });

  it('emits filterChange when a different chip is tapped', () => {
    const buttons = Array.from(chips());
    buttons[2].click(); // 4+ stars
    expect(host.changes).toEqual(['4stars']);
  });

  it('does not emit when the active chip is re-tapped', () => {
    host.active.set('edited');
    fixture.detectChanges();
    const buttons = Array.from(chips());
    buttons[3].click(); // Edited (already active)
    expect(host.changes).toEqual([]);
  });
});
