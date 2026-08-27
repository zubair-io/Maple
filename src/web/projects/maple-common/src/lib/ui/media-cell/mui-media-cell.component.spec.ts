import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiMediaCellComponent } from './mui-media-cell.component';

function render(): ComponentFixture<MuiMediaCellComponent> {
  TestBed.configureTestingModule({ imports: [MuiMediaCellComponent] });
  const fixture = TestBed.createComponent(MuiMediaCellComponent);
  fixture.componentRef.setInput('src', 'https://example.com/thumb.jpg');
  fixture.componentRef.setInput('alt', 'Ballet');
  fixture.componentRef.setInput('filename', 'DSC_0003.NEF');
  fixture.detectChanges();
  return fixture;
}

describe('MuiMediaCellComponent', () => {
  it('emits pressed on a thumbnail click, not on rename/rating interactions', () => {
    const fixture = render();
    let pressCount = 0;
    fixture.componentInstance.pressed.subscribe(() => pressCount++);

    (fixture.nativeElement.querySelector('.mui-media-cell') as HTMLElement).click();
    expect(pressCount).toBe(1);

    (fixture.nativeElement.querySelector('.meta') as HTMLElement).click();
    expect(pressCount).toBe(1); // stopPropagation keeps the meta row from re-triggering a press
  });

  it('shows the selection outline class when selected', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.mui-media-cell').className).not.toContain(
      'is-selected',
    );
    fixture.componentRef.setInput('selected', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-media-cell').className).toContain(
      'is-selected',
    );
  });

  it('renders badges and forwards a rename to the renamed output', () => {
    const fixture = render();
    fixture.componentRef.setInput('badges', ['RAW']);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.badges mui-badge').length).toBe(1);

    const renamed: string[] = [];
    fixture.componentInstance.renamed.subscribe((name) => renamed.push(name));

    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    control.value = 'ballet-003.nef';
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(renamed).toEqual(['ballet-003.nef']);
    expect(fixture.componentInstance.filename()).toBe('ballet-003.nef');
  });

  it('Enter/Space on the cell also emits pressed', () => {
    const fixture = render();
    let pressCount = 0;
    fixture.componentInstance.pressed.subscribe(() => pressCount++);
    const cell = fixture.nativeElement.querySelector('.mui-media-cell') as HTMLElement;
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(pressCount).toBe(1);
  });

  it('emits a MouseEvent payload on pressed, not just a bare notification', () => {
    const fixture = render();
    let received: MouseEvent | undefined;
    fixture.componentInstance.pressed.subscribe((e) => (received = e));
    (fixture.nativeElement.querySelector('.mui-media-cell') as HTMLElement).click();
    expect(received).toBeInstanceOf(MouseEvent);
  });
});

describe('MuiMediaCellComponent — overlay layout', () => {
  function renderOverlay(): ComponentFixture<MuiMediaCellComponent> {
    TestBed.configureTestingModule({ imports: [MuiMediaCellComponent] });
    const fixture = TestBed.createComponent(MuiMediaCellComponent);
    fixture.componentRef.setInput('src', 'https://example.com/thumb.jpg');
    fixture.componentRef.setInput('alt', 'Ballet');
    fixture.componentRef.setInput('layout', 'overlay');
    fixture.componentRef.setInput('size', 'fill');
    fixture.detectChanges();
    return fixture;
  }

  it('renders the interactive root as a native <button>, not a role="button" div', () => {
    const fixture = renderOverlay();
    const cell = fixture.nativeElement.querySelector('.mui-media-cell.overlay') as HTMLElement;
    expect(cell.tagName).toBe('BUTTON');
    expect(cell.getAttribute('role')).toBeNull();
  });

  it('carries the ariaLabel input as the button aria-label, and aria-pressed from selected', () => {
    const fixture = renderOverlay();
    fixture.componentRef.setInput('ariaLabel', 'IMG_0042.dng');
    fixture.componentRef.setInput('selected', false);
    fixture.detectChanges();
    const cell = fixture.nativeElement.querySelector('.mui-media-cell.overlay') as HTMLElement;
    expect(cell.getAttribute('aria-label')).toBe('IMG_0042.dng');
    expect(cell.getAttribute('aria-pressed')).toBe('false');

    fixture.componentRef.setInput('selected', true);
    fixture.detectChanges();
    expect(cell.getAttribute('aria-pressed')).toBe('true');
  });

  it('emits pressed with the click MouseEvent on a thumbnail click', () => {
    const fixture = renderOverlay();
    let received: MouseEvent | undefined;
    fixture.componentInstance.pressed.subscribe((e) => (received = e));
    (fixture.nativeElement.querySelector('.mui-media-cell.overlay') as HTMLElement).click();
    expect(received).toBeInstanceOf(MouseEvent);
  });

  it('applies is-dimmed when dimmed is true', () => {
    const fixture = renderOverlay();
    expect(fixture.nativeElement.querySelector('.overlay').classList).not.toContain('is-dimmed');
    fixture.componentRef.setInput('dimmed', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.overlay').classList).toContain('is-dimmed');
  });

  it('forwards placeholderBackground to the inner mui-image', () => {
    const fixture = renderOverlay();
    fixture.componentRef.setInput('src', '');
    fixture.componentRef.setInput('placeholderBackground', 'url(data:image/svg+xml,abc)');
    fixture.detectChanges();
    const gradient = fixture.nativeElement.querySelector('.gradient-placeholder') as HTMLElement;
    expect(gradient).toBeTruthy();
    expect(gradient.style.backgroundImage).toContain('data:image/svg+xml,abc');
  });

  it('projects mediaCellTopLeft/mediaCellTopRight content inside the corner overlay slots', () => {
    @Component({
      standalone: true,
      imports: [MuiMediaCellComponent],
      template: `
        <mui-media-cell layout="overlay" size="fill" src="a.jpg" alt="a">
          <div mediaCellTopLeft data-testid="hidden-badge">HIDDEN</div>
          <div mediaCellTopRight data-testid="select-checkbox"></div>
        </mui-media-cell>
      `,
    })
    class HostComponent {}

    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const topLeft = fixture.nativeElement.querySelector('.overlay-slot.top-left');
    const topRight = fixture.nativeElement.querySelector('.overlay-slot.top-right');
    expect(topLeft.querySelector('[data-testid="hidden-badge"]')).toBeTruthy();
    expect(topRight.querySelector('[data-testid="select-checkbox"]')).toBeTruthy();
  });

  it('projects mediaCellFooter content OUTSIDE the interactive button (sibling, not nested)', () => {
    @Component({
      standalone: true,
      imports: [MuiMediaCellComponent],
      template: `
        <mui-media-cell layout="overlay" size="fill" src="a.jpg" alt="a">
          <button mediaCellFooter type="button" data-testid="rename-trigger">a.jpg</button>
        </mui-media-cell>
      `,
    })
    class HostComponent {}

    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const cell = fixture.nativeElement.querySelector('.mui-media-cell.overlay') as HTMLElement;
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="rename-trigger"]',
    ) as HTMLElement;
    expect(trigger).toBeTruthy();
    // The whole point: it must NOT be a descendant of the button — nesting
    // real interactive controls inside a <button> is invalid, and this
    // projection split is what keeps `overlay` layout safe for that case.
    expect(cell.contains(trigger)).toBe(false);
  });

  it('renders the readonly rating-flags overlay row, not the editable stacked meta row', () => {
    const fixture = renderOverlay();
    fixture.componentRef.setInput('rating', 3);
    fixture.componentRef.setInput('flag', 'pick');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.meta')).toBeNull();
    expect(fixture.nativeElement.querySelector('mui-inline-rename-field')).toBeNull();
    const flagChip = fixture.nativeElement.querySelector('.flag-chip');
    expect(flagChip.textContent).toBe('PICK');
  });
});
