import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiBannerComponent } from './mui-banner.component';

function render(): ComponentFixture<MuiBannerComponent> {
  TestBed.configureTestingModule({ imports: [MuiBannerComponent] });
  const fixture = TestBed.createComponent(MuiBannerComponent);
  fixture.componentRef.setInput('message', 'Update available');
  fixture.detectChanges();
  return fixture;
}

describe('MuiBannerComponent', () => {
  it('renders the message and defaults to the info variant', () => {
    const fixture = render();
    expect(fixture.nativeElement.textContent).toContain('Update available');
    expect(fixture.nativeElement.querySelector('.mui-banner').className).toContain('variant-info');
  });

  it('every variant class is applied and only ghost buttons are used', () => {
    const fixture = render();
    fixture.componentRef.setInput('variant', 'error');
    fixture.componentRef.setInput('actionLabel', 'Retry');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-banner').className).toContain('variant-error');
    const button = fixture.nativeElement.querySelector('mui-button button');
    expect(button.className).toContain('variant-ghost');
  });

  it('shows an optional link and emits actionPressed from the action button', () => {
    const fixture = render();
    fixture.componentRef.setInput('linkLabel', 'Learn more');
    fixture.componentRef.setInput('linkHref', 'https://justmaple.app');
    fixture.componentRef.setInput('actionLabel', 'Update now');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-link').textContent).toContain('Learn more');

    const actionPressed: void[] = [];
    fixture.componentInstance.actionPressed.subscribe(() => actionPressed.push(undefined));
    (fixture.nativeElement.querySelectorAll('mui-button button')[0] as HTMLButtonElement).click();
    expect(actionPressed.length).toBe(1);
  });

  it('a dismissible banner shows a dismiss control that emits dismissed', () => {
    const fixture = render();
    fixture.componentRef.setInput('dismissible', true);
    fixture.detectChanges();
    const dismissed: void[] = [];
    fixture.componentInstance.dismissed.subscribe(() => dismissed.push(undefined));

    const button = fixture.nativeElement.querySelector(
      'button[aria-label="Dismiss"]',
    ) as HTMLButtonElement;
    button.click();
    expect(dismissed.length).toBe(1);
  });
});
