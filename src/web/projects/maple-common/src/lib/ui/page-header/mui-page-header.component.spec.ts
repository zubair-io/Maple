import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageHeaderComponent } from './mui-page-header.component';

@Component({
  standalone: true,
  imports: [MuiPageHeaderComponent],
  template: `
    <mui-page-header
      title="test_0003"
      [showBack]="showBack"
      [showMore]="showMore"
      (back)="backCount = backCount + 1"
      (more)="moreCount = moreCount + 1"
    >
      <button actions type="button" class="custom-action">Share</button>
    </mui-page-header>
  `,
})
class HostComponent {
  showBack = true;
  showMore = false;
  backCount = 0;
  moreCount = 0;
}

describe('MuiPageHeaderComponent', () => {
  it('renders the title and a leading back button by default', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.title').textContent.trim()).toBe('test_0003');
    expect(fixture.nativeElement.querySelector('[aria-label="Back"]')).toBeTruthy();
  });

  it('hides the back button when showBack is false', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.showBack = false;
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[aria-label="Back"]')).toBeNull();
  });

  it('emits back when the back button is pressed', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[aria-label="Back"]').click();
    expect(fixture.componentInstance.backCount).toBe(1);
  });

  it('projects custom trailing actions and shows an optional More button that emits more', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.showMore = true;
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.custom-action').textContent).toBe('Share');
    const more = fixture.nativeElement.querySelector('[aria-label="More"]');
    expect(more).toBeTruthy();
    more.click();
    expect(fixture.componentInstance.moreCount).toBe(1);
  });
});
