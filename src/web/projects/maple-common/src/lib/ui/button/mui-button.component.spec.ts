import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiButtonComponent } from './mui-button.component';

function render(): ComponentFixture<MuiButtonComponent> {
  TestBed.configureTestingModule({ imports: [MuiButtonComponent] });
  const fixture = TestBed.createComponent(MuiButtonComponent);
  fixture.detectChanges();
  return fixture;
}

function button(fixture: ComponentFixture<MuiButtonComponent>): HTMLButtonElement {
  return fixture.nativeElement.querySelector('button') as HTMLButtonElement;
}

describe('MuiButtonComponent', () => {
  it('renders a button with the default secondary/md variant classes', () => {
    const fixture = render();
    const btn = button(fixture);
    expect(btn.className).toContain('variant-secondary');
    expect(btn.className).toContain('size-md');
  });

  it('reflects each variant and size input as a rendered class', () => {
    const fixture = render();
    for (const variant of ['primary', 'secondary', 'ghost', 'destructive'] as const) {
      fixture.componentRef.setInput('variant', variant);
      fixture.detectChanges();
      expect(button(fixture).className).toContain(`variant-${variant}`);
    }
    for (const size of ['sm', 'md', 'lg'] as const) {
      fixture.componentRef.setInput('size', size);
      fixture.detectChanges();
      expect(button(fixture).className).toContain(`size-${size}`);
    }
  });

  it('emits pressed on click', () => {
    const fixture = render();
    let emitted: MouseEvent | null = null;
    fixture.componentInstance.pressed.subscribe((e: MouseEvent) => (emitted = e));
    button(fixture).click();
    expect(emitted).not.toBeNull();
  });

  it('disabled blocks both the click handler and native interaction', () => {
    const fixture = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    let emitted = false;
    fixture.componentInstance.pressed.subscribe(() => (emitted = true));
    const btn = button(fixture);
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(emitted).toBe(false);
  });

  it('loading blocks clicks, marks aria-busy, and renders a spinner instead of the leading icon', () => {
    const fixture = render();
    fixture.componentRef.setInput('loading', true);
    fixture.componentRef.setInput('iconLeading', 'plus');
    fixture.detectChanges();
    const btn = button(fixture);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.spinner')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-icon')).toBeNull();
    let emitted = false;
    fixture.componentInstance.pressed.subscribe(() => (emitted = true));
    btn.click();
    expect(emitted).toBe(false);
  });

  it('forwards ariaExpanded to the native button as aria-expanded, omitting it when unset', () => {
    const fixture = render();
    expect(button(fixture).getAttribute('aria-expanded')).toBeNull();

    fixture.componentRef.setInput('ariaExpanded', true);
    fixture.detectChanges();
    expect(button(fixture).getAttribute('aria-expanded')).toBe('true');

    fixture.componentRef.setInput('ariaExpanded', false);
    fixture.detectChanges();
    expect(button(fixture).getAttribute('aria-expanded')).toBe('false');
  });

  it('forwards ariaPressed to the native button as aria-pressed, omitting it when unset', () => {
    const fixture = render();
    expect(button(fixture).getAttribute('aria-pressed')).toBeNull();

    fixture.componentRef.setInput('ariaPressed', true);
    fixture.detectChanges();
    expect(button(fixture).getAttribute('aria-pressed')).toBe('true');

    fixture.componentRef.setInput('ariaPressed', false);
    fixture.detectChanges();
    expect(button(fixture).getAttribute('aria-pressed')).toBe('false');
  });

  it('forwards ariaHasPopup to the native button, omitting it when unset', () => {
    const fixture = render();
    expect(button(fixture).getAttribute('aria-haspopup')).toBeNull();

    fixture.componentRef.setInput('ariaHasPopup', 'menu');
    fixture.detectChanges();
    expect(button(fixture).getAttribute('aria-haspopup')).toBe('menu');
  });

  it('active renders the colored toggle-on state; toggled renders the subtler chrome overlay', () => {
    const fixture = render();
    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
    expect(button(fixture).className).toContain('is-active');

    fixture.componentRef.setInput('active', false);
    fixture.componentRef.setInput('toggled', true);
    fixture.detectChanges();
    expect(button(fixture).className).not.toContain('is-active');
    expect(button(fixture).className).toContain('is-toggled');
  });

  it('icon-only mode hides the label and requires the caller to supply an aria-label', () => {
    const fixture = render();
    fixture.componentRef.setInput('iconOnly', true);
    fixture.componentRef.setInput('iconLeading', 'x');
    fixture.componentRef.setInput('ariaLabel', 'Close');
    fixture.detectChanges();
    const btn = button(fixture);
    expect(btn.className).toContain('icon-only');
    expect(fixture.nativeElement.querySelector('.label')).toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Close');
    expect(fixture.nativeElement.querySelector('mui-icon')).toBeTruthy();
  });

  it('focus() forwards to the native button element', () => {
    const fixture = render();
    fixture.componentInstance.focus();
    expect(document.activeElement).toBe(button(fixture));
  });
});
