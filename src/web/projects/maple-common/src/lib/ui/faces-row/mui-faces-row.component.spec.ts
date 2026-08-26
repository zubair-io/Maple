import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiFacesRowComponent } from './mui-faces-row.component';

const PEOPLE = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
];

function render(): ComponentFixture<MuiFacesRowComponent> {
  TestBed.configureTestingModule({ imports: [MuiFacesRowComponent] });
  const fixture = TestBed.createComponent(MuiFacesRowComponent);
  fixture.componentRef.setInput('people', PEOPLE);
  fixture.detectChanges();
  return fixture;
}

describe('MuiFacesRowComponent', () => {
  it('renders a pluralized count label', () => {
    const fixture = render();
    expect(fixture.nativeElement.textContent).toContain('2 people');

    fixture.componentRef.setInput('people', [PEOPLE[0]]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('1 person');
  });

  it('selecting a chip updates selectedId', () => {
    const fixture = render();
    const chips = fixture.nativeElement.querySelectorAll('.chip');
    (chips[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedId()).toBe('b');
  });

  it('emits redetect on the Re-detect button click', () => {
    const fixture = render();
    let count = 0;
    fixture.componentInstance.redetect.subscribe(() => count++);
    (fixture.nativeElement.querySelector('.mui-button') as HTMLButtonElement).click();
    expect(count).toBe(1);
  });

  it('totalCount overrides the label to "N faces detected" (tagged + untagged)', () => {
    const fixture = render();
    fixture.componentRef.setInput('totalCount', 5);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('5 faces detected');
    expect(fixture.nativeElement.textContent).not.toContain('2 people');
  });

  it('renders and emits from the "+N unnamed" pill only when untaggedCount is positive', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.untagged')).toBeNull();

    fixture.componentRef.setInput('untaggedCount', 3);
    fixture.detectChanges();
    const pill = fixture.nativeElement.querySelector('.untagged') as HTMLButtonElement;
    expect(pill.textContent).toContain('3 unnamed');

    let count = 0;
    fixture.componentInstance.untaggedClicked.subscribe(() => count++);
    pill.click();
    expect(count).toBe(1);
  });
});
