import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiEmbedShellComponent } from './mui-embed-shell.component';

@Component({
  standalone: true,
  imports: [MuiEmbedShellComponent],
  template: `
    <mui-embed-shell
      title="Voice memo"
      statusIcon="camera"
      statusLabel="Recording"
      [loading]="loading()"
      (back)="backCount = backCount + 1"
    >
      <div class="projected">Embed body</div>
    </mui-embed-shell>
  `,
})
class HostComponent {
  readonly loading = signal(false);
  backCount = 0;
}

function render(): ComponentFixture<HostComponent> {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiEmbedShellComponent', () => {
  it('renders the page header title and projected body', () => {
    const fixture = render();
    expect(fixture.nativeElement.textContent).toContain('Voice memo');
    expect(fixture.nativeElement.querySelector('.projected').textContent).toBe('Embed body');
  });

  it('shows the status icon/label row when statusIcon is set', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.status')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Recording');
  });

  it('shows a progress bar only while loading', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-progress')).toBeNull();
    fixture.componentInstance.loading.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-progress')).toBeTruthy();
  });

  it('emits back when the page header back button is pressed', () => {
    const fixture = render();
    const backButton = fixture.nativeElement.querySelector(
      'mui-page-header button[aria-label="Back"]',
    ) as HTMLButtonElement;
    backButton.click();
    expect(fixture.componentInstance.backCount).toBe(1);
  });
});
