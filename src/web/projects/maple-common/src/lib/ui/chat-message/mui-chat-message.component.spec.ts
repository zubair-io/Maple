import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiChatMessageComponent } from './mui-chat-message.component';

function render(): ComponentFixture<MuiChatMessageComponent> {
  TestBed.configureTestingModule({ imports: [MuiChatMessageComponent] });
  const fixture = TestBed.createComponent(MuiChatMessageComponent);
  fixture.componentRef.setInput('author', 'Sam');
  fixture.componentRef.setInput('text', 'Sounds good!');
  fixture.componentRef.setInput('sentAt', Date.now() - 60_000);
  fixture.detectChanges();
  return fixture;
}

describe('MuiChatMessageComponent', () => {
  it('renders an avatar, author, and message text for another user', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-avatar')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Sam');
    expect(fixture.nativeElement.textContent).toContain('Sounds good!');
  });

  it('omits the avatar and author for own messages, aligning right', () => {
    const fixture = render();
    fixture.componentRef.setInput('own', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-avatar')).toBeNull();
    expect(fixture.nativeElement.querySelector('.author')).toBeNull();
    expect(fixture.nativeElement.querySelector('.mui-chat-message').className).toContain('is-own');
  });
});
