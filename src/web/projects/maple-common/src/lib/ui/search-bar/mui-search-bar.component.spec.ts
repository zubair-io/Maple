import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSearchBarComponent } from './mui-search-bar.component';

function render(): ComponentFixture<MuiSearchBarComponent> {
  TestBed.configureTestingModule({ imports: [MuiSearchBarComponent] });
  const fixture = TestBed.createComponent(MuiSearchBarComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiSearchBarComponent', () => {
  it('typing updates the value model and shows the clear affordance', () => {
    const fixture = render();
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    control.value = 'sunset';
    control.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe('sunset');
    expect(fixture.nativeElement.querySelector('.clear')).toBeTruthy();
  });

  it('clicking clear empties the value', () => {
    const fixture = render();
    fixture.componentRef.setInput('value', 'sunset');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.clear') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('');
  });

  it('emits committed on Enter', () => {
    const fixture = render();
    const committed: string[] = [];
    fixture.componentInstance.committed.subscribe((v) => committed.push(v));
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    control.value = 'query';
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(committed).toEqual(['query']);
  });

  it('renders an optional trailing action button and emits actionPressed', () => {
    const fixture = render();
    fixture.componentRef.setInput('actionLabel', 'Filters');
    fixture.detectChanges();
    const pressed: void[] = [];
    fixture.componentInstance.actionPressed.subscribe(() => pressed.push(undefined));

    const button = fixture.nativeElement.querySelector('mui-button button') as HTMLButtonElement;
    expect(button.textContent).toContain('Filters');
    button.click();
    expect(pressed.length).toBe(1);
  });

  it('omits the action button when no actionLabel is given', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-button')).toBeNull();
  });
});
