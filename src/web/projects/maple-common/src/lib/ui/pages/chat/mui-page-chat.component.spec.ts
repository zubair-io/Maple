import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageChatComponent } from './mui-page-chat.component';

describe('MuiPageChatComponent', () => {
  it('renders Chat in Center and Thread Panel in the Split Layout detail slot', () => {
    const fixture = TestBed.createComponent(MuiPageChatComponent);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('mui-chat')).toBeTruthy();
    expect(el.querySelector('[slot=detail] mui-thread-panel')).toBeTruthy();
  });

  it('switches both Chat messages and Thread Panel replies when the channel changes', () => {
    const fixture = TestBed.createComponent(MuiPageChatComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.chatMessages()[0]?.author).toBe('Sam');
    expect(fixture.componentInstance.threadMessages().length).toBe(1);

    fixture.componentInstance.selectChannel('general');
    fixture.detectChanges();

    expect(fixture.componentInstance.chatMessages()[0]?.author).toBe('Priya');
    expect(fixture.componentInstance.threadMessages().length).toBe(0);
  });

  it('appends a sent message to the active channel only', () => {
    const fixture = TestBed.createComponent(MuiPageChatComponent);
    fixture.detectChanges();

    const before = fixture.componentInstance.chatMessages().length;
    fixture.componentInstance.onMessageSent('Ship it');
    fixture.detectChanges();

    expect(fixture.componentInstance.chatMessages().length).toBe(before + 1);
    expect(fixture.componentInstance.chatMessages().at(-1)?.text).toBe('Ship it');

    fixture.componentInstance.selectChannel('general');
    fixture.detectChanges();
    expect(fixture.componentInstance.chatMessages().some((m) => m.text === 'Ship it')).toBe(false);
  });
});
