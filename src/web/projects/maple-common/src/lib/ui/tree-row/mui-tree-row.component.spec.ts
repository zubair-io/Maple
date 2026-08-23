import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiTreeRowComponent } from './mui-tree-row.component';

function render(): ComponentFixture<MuiTreeRowComponent> {
  TestBed.configureTestingModule({ imports: [MuiTreeRowComponent] });
  const fixture = TestBed.createComponent(MuiTreeRowComponent);
  fixture.componentRef.setInput('label', 'Notebooks');
  fixture.detectChanges();
  return fixture;
}

describe('MuiTreeRowComponent', () => {
  it('renders the label and an optional trailing count badge', () => {
    const fixture = render();
    fixture.componentRef.setInput('count', 12);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.row-label').textContent).toContain('Notebooks');
    expect(fixture.nativeElement.querySelector('mui-badge')).toBeTruthy();
  });

  it('shows a spinner instead of the count badge while loading', () => {
    const fixture = render();
    fixture.componentRef.setInput('count', 12);
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-spinner')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-badge')).toBeNull();
  });

  it('an expandable row shows a chevron that toggles `expanded` without triggering the row press', () => {
    const fixture = render();
    fixture.componentRef.setInput('expandable', true);
    fixture.detectChanges();
    const pressed: void[] = [];
    fixture.componentInstance.pressed.subscribe(() => pressed.push(undefined));

    const chevron = fixture.nativeElement.querySelector('.chevron') as HTMLButtonElement;
    expect(chevron).toBeTruthy();
    chevron.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.expanded()).toBe(true);
    expect(chevron.className).toContain('is-expanded');
    expect(pressed.length).toBe(0);
  });

  it('clicking the row (not the chevron) emits pressed', () => {
    const fixture = render();
    const pressed: void[] = [];
    fixture.componentInstance.pressed.subscribe(() => pressed.push(undefined));
    (fixture.nativeElement.querySelector('.mui-tree-row') as HTMLElement).click();
    expect(pressed.length).toBe(1);
  });

  it('applies the active-row treatment and exposes aria-current', () => {
    const fixture = render();
    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('.mui-tree-row');
    expect(row.className).toContain('is-active');
    expect(row.getAttribute('aria-current')).toBe('true');
  });

  it('indents by depth', () => {
    const fixture = render();
    fixture.componentRef.setInput('depth', 2);
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('.mui-tree-row') as HTMLElement;
    expect(row.style.paddingLeft).toBe('32px');
  });
});
