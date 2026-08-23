import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiChatComponent } from './mui-chat.component';
import type { MuiChatMessageData, MuiMentionableUser } from './mui-chat.component';

const MESSAGES: MuiChatMessageData[] = [
  { id: 'm1', author: 'Ada', text: 'Hey there', sentAt: Date.now() - 60_000 },
];

const USERS: MuiMentionableUser[] = [
  { id: 'u1', name: 'Ada Lovelace' },
  { id: 'u2', name: 'Grace Hopper' },
];

@Component({
  standalone: true,
  imports: [MuiChatComponent],
  template: `
    <mui-chat
      [messages]="messages()"
      [othersTyping]="othersTyping()"
      [mentionableUsers]="users()"
      [(composerValue)]="composerValue"
      (messageSent)="lastSent = $event"
      (mentionSelected)="lastMention = $event"
    />
  `,
})
class HostComponent {
  readonly messages = signal<readonly MuiChatMessageData[]>(MESSAGES);
  readonly othersTyping = signal(false);
  readonly users = signal<readonly MuiMentionableUser[]>(USERS);
  readonly composerValue = signal('');
  lastSent: string | null = null;
  lastMention: string | null = null;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

function composerInput(fixture: ComponentFixture<HostComponent>): HTMLInputElement {
  return (fixture.nativeElement as HTMLElement).querySelector(
    '.composer input',
  ) as HTMLInputElement;
}

describe('MuiChatComponent', () => {
  it('renders one chat message per entry and no typing indicator by default', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('mui-chat-message').length).toBe(1);
    expect(el.querySelector('mui-typing-indicator')).toBeNull();
  });

  it('shows the typing indicator when othersTyping is true', () => {
    const { fixture, host } = render();
    host.othersTyping.set(true);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('mui-typing-indicator'),
    ).not.toBeNull();
  });

  it('opens the suggestion menu and filters it once "@" appears in the composer', () => {
    const { fixture, host } = render();
    host.composerValue.set('hey @gr');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const options = el.querySelectorAll('.mui-suggestion-menu .item');
    expect(options.length).toBe(1);
    expect(options[0].textContent).toContain('Grace Hopper');
  });

  it('closes the suggestion menu once whitespace follows the @-query', () => {
    const { fixture, host } = render();
    host.composerValue.set('hey @gr');
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.mui-suggestion-menu'),
    ).not.toBeNull();

    host.composerValue.set('hey @gr ');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.mui-suggestion-menu')).toBeNull();
  });

  it('emits mentionSelected and substitutes the mention text on click', () => {
    const { fixture, host } = render();
    host.composerValue.set('hey @gr');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('.mui-suggestion-menu .item') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.lastMention).toBe('u2');
    expect(host.composerValue()).toBe('hey @Grace Hopper ');
  });

  it('emits messageSent with the trimmed text and clears the composer on Enter', () => {
    const { fixture, host } = render();
    host.composerValue.set('  hello world  ');
    fixture.detectChanges();
    const input = composerInput(fixture);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(host.lastSent).toBe('hello world');
    expect(host.composerValue()).toBe('');
  });

  it('does not send a blank composer', () => {
    const { fixture, host } = render();
    host.composerValue.set('   ');
    fixture.detectChanges();
    const input = composerInput(fixture);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.lastSent).toBeNull();
  });
});
