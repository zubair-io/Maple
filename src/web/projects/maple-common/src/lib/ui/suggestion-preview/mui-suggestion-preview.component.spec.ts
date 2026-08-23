import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSuggestionPreviewComponent } from './mui-suggestion-preview.component';

function render(): ComponentFixture<MuiSuggestionPreviewComponent> {
  TestBed.configureTestingModule({ imports: [MuiSuggestionPreviewComponent] });
  const fixture = TestBed.createComponent(MuiSuggestionPreviewComponent);
  fixture.componentRef.setInput('description', 'Rewrite paragraph');
  fixture.detectChanges();
  return fixture;
}

describe('MuiSuggestionPreviewComponent', () => {
  it('shows accept/reject buttons while unresolved', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('button[aria-label="Accept"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('button[aria-label="Reject"]')).toBeTruthy();
  });

  it('emits accepted/rejected on the respective button', () => {
    const fixture = render();
    let accepted = 0;
    let rejected = 0;
    fixture.componentInstance.accepted.subscribe(() => accepted++);
    fixture.componentInstance.rejected.subscribe(() => rejected++);

    (
      fixture.nativeElement.querySelector('button[aria-label="Accept"]') as HTMLButtonElement
    ).click();
    expect(accepted).toBe(1);
    expect(rejected).toBe(0);
  });

  it('shows a resolved label instead of the actions once resolved', () => {
    const fixture = render();
    fixture.componentRef.setInput('resolved', 'accepted');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button[aria-label="Accept"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Accepted');
  });
});
