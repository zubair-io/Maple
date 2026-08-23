import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiThreadPanelComponent } from './mui-thread-panel.component';

const MESSAGES = [
  { id: 'm1', author: 'Ada', sentAt: Date.now() - 60_000, text: 'Looks great' },
  { id: 'm2', author: 'You', sentAt: Date.now() - 30_000, text: 'Thanks!', own: true },
];

function render(): ComponentFixture<MuiThreadPanelComponent> {
  TestBed.configureTestingModule({ imports: [MuiThreadPanelComponent] });
  const fixture = TestBed.createComponent(MuiThreadPanelComponent);
  fixture.componentRef.setInput('messages', MESSAGES);
  fixture.detectChanges();
  return fixture;
}

describe('MuiThreadPanelComponent', () => {
  it('shows a spinner while loading', () => {
    TestBed.configureTestingModule({ imports: [MuiThreadPanelComponent] });
    const fixture = TestBed.createComponent(MuiThreadPanelComponent);
    fixture.componentRef.setInput('messages', MESSAGES);
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-spinner')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('mui-chat-message')).toBeNull();
  });

  it('shows an empty state when there are no messages', () => {
    TestBed.configureTestingModule({ imports: [MuiThreadPanelComponent] });
    const fixture = TestBed.createComponent(MuiThreadPanelComponent);
    fixture.componentRef.setInput('messages', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-empty-state')).not.toBeNull();
  });

  it('renders one chat message per item, own flag passed through', () => {
    const fixture = render();
    const bubbles = fixture.nativeElement.querySelectorAll('mui-chat-message');
    expect(bubbles.length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('Looks great');
    expect(fixture.nativeElement.textContent).toContain('Thanks!');
  });

  it('sending trims the draft, emits it, and clears the composer', () => {
    const fixture = render();
    const sent: string[] = [];
    fixture.componentInstance.sent.subscribe((text) => sent.push(text));

    const control = fixture.nativeElement.querySelector('.composer .control') as HTMLInputElement;
    control.value = '  Sounds good  ';
    control.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const sendButton = fixture.nativeElement.querySelector(
      '.composer mui-button button',
    ) as HTMLButtonElement;
    sendButton.click();
    fixture.detectChanges();

    expect(sent).toEqual(['Sounds good']);
    expect(fixture.componentInstance.draft()).toBe('');
  });

  it('pressing Enter in the reply input sends via the committed event', () => {
    const fixture = render();
    const sent: string[] = [];
    fixture.componentInstance.sent.subscribe((text) => sent.push(text));

    const control = fixture.nativeElement.querySelector('.composer .control') as HTMLInputElement;
    control.value = 'Enter-to-send';
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(sent).toEqual(['Enter-to-send']);
    expect(fixture.componentInstance.draft()).toBe('');
  });

  it('does not send an empty or whitespace-only draft', () => {
    const fixture = render();
    const sent: string[] = [];
    fixture.componentInstance.sent.subscribe((text) => sent.push(text));

    const sendButton = fixture.nativeElement.querySelector(
      '.composer mui-button button',
    ) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    fixture.componentInstance.draft.set('   ');
    fixture.detectChanges();
    fixture.componentInstance.send();
    expect(sent).toEqual([]);
  });

  it('disables the input and send button while sending', () => {
    const fixture = render();
    fixture.componentRef.setInput('sending', true);
    fixture.componentInstance.draft.set('queued reply');
    fixture.detectChanges();

    const control = fixture.nativeElement.querySelector('.composer .control') as HTMLInputElement;
    const sendButton = fixture.nativeElement.querySelector(
      '.composer mui-button button',
    ) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);

    const sent: string[] = [];
    fixture.componentInstance.sent.subscribe((text) => sent.push(text));
    fixture.componentInstance.send();
    expect(sent).toEqual([]);
  });
});
