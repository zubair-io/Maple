import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiEmptyStateComponent } from './mui-empty-state.component';

function render(): ComponentFixture<MuiEmptyStateComponent> {
  TestBed.configureTestingModule({ imports: [MuiEmptyStateComponent] });
  const fixture = TestBed.createComponent(MuiEmptyStateComponent);
  fixture.componentRef.setInput('icon', 'photos');
  fixture.componentRef.setInput('title', 'No messages yet');
  fixture.detectChanges();
  return fixture;
}

describe('MuiEmptyStateComponent', () => {
  it('renders the icon and title', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-icon')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.title').textContent).toContain('No messages yet');
  });

  it('shows an optional message', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.message')).toBeNull();
    fixture.componentRef.setInput('message', 'New messages will show up here.');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.message').textContent).toContain(
      'New messages will show up here.',
    );
  });

  it('shows an optional action button and emits actionPressed', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-button')).toBeNull();

    fixture.componentRef.setInput('actionLabel', 'Refresh');
    fixture.detectChanges();
    const pressed: void[] = [];
    fixture.componentInstance.actionPressed.subscribe(() => pressed.push(undefined));
    (fixture.nativeElement.querySelector('mui-button button') as HTMLButtonElement).click();
    expect(pressed.length).toBe(1);
  });
});
