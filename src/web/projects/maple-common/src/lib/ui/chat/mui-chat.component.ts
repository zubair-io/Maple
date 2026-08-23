// MuiChat — Maple UI Organisms (Wave W6 Lane B). A conversation surface —
// message history, a typing indicator, and an @-mention composer — built
// from Chat Message, Typing Indicator, Input, Suggestion Menu. All state
// (messages, who's typing, who can be mentioned) comes from inputs; there
// is no networking here.
//
// Mention detection: the composer's `@`-trigger is whatever comes after the
// LAST `@` in the current text, as long as no whitespace has been typed
// since — the usual "still composing a handle" rule. Selecting a
// suggestion is mouse/click-only: mui-input owns its own native `keydown`
// listener and already emits `committed` (send) on Enter directly from the
// target element, so an ancestor listener on this component can't intercept
// that same Enter before mui-input's own handler has already fired. Rather
// than fight that ordering by reaching into mui-input's internals, Enter
// always sends — arrow keys still drive the highlighted suggestion via a
// forwarded (non-Enter) keydown for visual navigation.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';
import { MuiChatMessageComponent } from '../chat-message/mui-chat-message.component';
import { MuiInputComponent } from '../input/mui-input.component';
import { MuiSuggestionMenuComponent } from '../suggestion-menu/mui-suggestion-menu.component';
import type { MuiSuggestionItem } from '../suggestion-menu/mui-suggestion-menu.component';
import { MuiTypingIndicatorComponent } from '../typing-indicator/mui-typing-indicator.component';

export interface MuiChatMessageData {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly sentAt: Date | number;
  readonly own?: boolean;
}

export interface MuiMentionableUser {
  readonly id: string;
  readonly name: string;
}

@Component({
  selector: 'mui-chat',
  standalone: true,
  imports: [
    MuiChatMessageComponent,
    MuiInputComponent,
    MuiSuggestionMenuComponent,
    MuiTypingIndicatorComponent,
  ],
  templateUrl: './mui-chat.component.html',
  styleUrl: './mui-chat.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiChatComponent {
  readonly messages = input.required<readonly MuiChatMessageData[]>();
  readonly othersTyping = input<boolean>(false);
  readonly typingUserName = input<string>('Someone');
  readonly mentionableUsers = input.required<readonly MuiMentionableUser[]>();
  readonly composerValue = model<string>('');

  readonly messageSent = output<string>();
  readonly mentionSelected = output<string>();

  readonly suggestionMenu = viewChild(MuiSuggestionMenuComponent);

  readonly mentionQuery = computed<string | null>(() => {
    const value = this.composerValue();
    const at = value.lastIndexOf('@');
    if (at === -1) return null;
    const after = value.slice(at + 1);
    if (/\s/.test(after)) return null;
    return after;
  });

  readonly suggestionItems = computed<readonly MuiSuggestionItem[]>(() => {
    const query = this.mentionQuery();
    if (query === null) return [];
    const lower = query.toLowerCase();
    return this.mentionableUsers()
      .filter((user) => user.name.toLowerCase().includes(lower))
      .map((user) => ({ id: user.id, label: user.name }));
  });

  readonly suggestionsOpen = computed(
    () => this.mentionQuery() !== null && this.suggestionItems().length > 0,
  );

  onComposerKeydown(event: KeyboardEvent): void {
    if (!this.suggestionsOpen()) return;
    if (event.key === 'Enter') return; // let mui-input's own handler send.
    this.suggestionMenu()?.onKeydown(event);
  }

  onMentionSelect(userId: string): void {
    const user = this.mentionableUsers().find((candidate) => candidate.id === userId);
    if (!user) return;
    const value = this.composerValue();
    const at = value.lastIndexOf('@');
    const next = at === -1 ? value : `${value.slice(0, at)}@${user.name} `;
    this.composerValue.set(next);
    this.mentionSelected.emit(userId);
  }

  onComposerCommitted(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    this.messageSent.emit(trimmed);
    this.composerValue.set('');
  }
}
