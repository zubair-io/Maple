import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiActionButtonComponent } from './mui-action-button.component';

function render(): ComponentFixture<MuiActionButtonComponent> {
  TestBed.configureTestingModule({ imports: [MuiActionButtonComponent] });
  const fixture = TestBed.createComponent(MuiActionButtonComponent);
  fixture.componentRef.setInput('icon', 'search');
  fixture.componentRef.setInput('label', 'Search');
  fixture.detectChanges();
  return fixture;
}

function button(fixture: ComponentFixture<MuiActionButtonComponent>): HTMLButtonElement {
  return fixture.nativeElement.querySelector('button') as HTMLButtonElement;
}

describe('MuiActionButtonComponent', () => {
  it('renders the icon and visible label', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-icon')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.label')?.textContent).toBe('Search');
  });

  it('reflects size and orientation inputs as rendered classes', () => {
    const fixture = render();
    fixture.componentRef.setInput('size', 'sm');
    fixture.componentRef.setInput('orientation', 'stacked');
    fixture.detectChanges();
    expect(button(fixture).className).toContain('size-sm');
    expect(button(fixture).className).toContain('orientation-stacked');
  });

  it('marks the selected state via a class and aria-pressed', () => {
    const fixture = render();
    expect(button(fixture).getAttribute('aria-pressed')).toBe('false');
    fixture.componentRef.setInput('selected', true);
    fixture.detectChanges();
    expect(button(fixture).className).toContain('selected');
    expect(button(fixture).getAttribute('aria-pressed')).toBe('true');
  });

  it('emits pressed on click, and disabled blocks it', () => {
    const fixture = render();
    let count = 0;
    fixture.componentInstance.pressed.subscribe(() => count++);
    button(fixture).click();
    expect(count).toBe(1);

    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(button(fixture).disabled).toBe(true);
    button(fixture).click();
    expect(count).toBe(1);
  });

  it('sets the title attribute only when provided', () => {
    const fixture = render();
    expect(button(fixture).hasAttribute('title')).toBe(false);

    fixture.componentRef.setInput('title', 'Mask — coming in #1541');
    fixture.detectChanges();
    expect(button(fixture).getAttribute('title')).toBe('Mask — coming in #1541');
  });

  it('ariaHidden removes the button from the a11y tree and tab order', () => {
    const fixture = render();
    expect(button(fixture).getAttribute('aria-hidden')).toBeNull();
    expect(button(fixture).getAttribute('tabindex')).toBeNull();

    fixture.componentRef.setInput('ariaHidden', true);
    fixture.detectChanges();
    expect(button(fixture).getAttribute('aria-hidden')).toBe('true');
    expect(button(fixture).getAttribute('tabindex')).toBe('-1');
  });

  it('shows a modified dot only when the modified input is set', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.modified-dot')).toBeNull();

    fixture.componentRef.setInput('modified', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.modified-dot')).not.toBeNull();
  });
});
