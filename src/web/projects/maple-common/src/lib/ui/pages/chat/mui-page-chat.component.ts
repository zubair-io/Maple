// MuiPageChat — Maple UI Pages (unified-component-catalog.md §6). Split
// Layout: a channel-switcher list in Sidebar, the Chat organism in Center,
// and the Thread Panel in Detail.
//
// Cross-organism wiring: picking a channel in Sidebar swaps both the Chat
// organism's message list AND the Thread Panel's replies (each channel
// carries its own conversation + thread) — one selection, two organisms
// updated. Sending a chat message appends to that channel's own history.

import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MuiSplitLayoutComponent } from '../../split-layout/mui-split-layout.component';
import { MuiListRowComponent } from '../../list-row/mui-list-row.component';
import { MuiChatComponent } from '../../chat/mui-chat.component';
import type { MuiChatMessageData, MuiMentionableUser } from '../../chat/mui-chat.component';
import { MuiThreadPanelComponent } from '../../thread-panel/mui-thread-panel.component';
import type { MuiThreadMessage } from '../../thread-panel/mui-thread-panel.component';

interface Channel {
  readonly id: string;
  readonly label: string;
}

const CHANNELS: readonly Channel[] = [
  { id: 'design', label: '#design' },
  { id: 'general', label: '#general' },
];

const BASE_TIME = new Date('2026-03-04T14:00:00Z').getTime();

const INITIAL_MESSAGES: Readonly<Record<string, readonly MuiChatMessageData[]>> = {
  design: [
    {
      id: 'd1',
      author: 'Sam',
      text: 'Loving the new AgX look on the coastal set.',
      sentAt: BASE_TIME - 5 * 60_000,
    },
    {
      id: 'd2',
      author: 'You',
      text: 'Thanks — dialed in the highlight rolloff last night.',
      sentAt: BASE_TIME - 4 * 60_000,
      own: true,
    },
  ],
  general: [
    {
      id: 'g1',
      author: 'Priya',
      text: 'Standup moved to 10am tomorrow.',
      sentAt: BASE_TIME - 60 * 60_000,
    },
  ],
};

const INITIAL_THREADS: Readonly<Record<string, readonly MuiThreadMessage[]>> = {
  design: [
    {
      id: 't1',
      author: 'Sam',
      sentAt: BASE_TIME - 2 * 60_000,
      text: 'Reply here about the rolloff curve.',
    },
  ],
  general: [],
};

@Component({
  selector: 'mui-page-chat',
  standalone: true,
  imports: [
    MuiSplitLayoutComponent,
    MuiListRowComponent,
    MuiChatComponent,
    MuiThreadPanelComponent,
  ],
  templateUrl: './mui-page-chat.component.html',
  styleUrl: './mui-page-chat.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageChatComponent {
  readonly channels = CHANNELS;
  readonly activeChannelId = signal<string>(CHANNELS[0].id);

  readonly mentionableUsers: readonly MuiMentionableUser[] = [
    { id: 'u1', name: 'Sam Ortiz' },
    { id: 'u2', name: 'Priya Shah' },
  ];

  private readonly messagesByChannel = signal(INITIAL_MESSAGES);
  private readonly threadsByChannel = signal(INITIAL_THREADS);

  readonly chatMessages = computed<readonly MuiChatMessageData[]>(
    () => this.messagesByChannel()[this.activeChannelId()] ?? [],
  );
  readonly threadMessages = computed<readonly MuiThreadMessage[]>(
    () => this.threadsByChannel()[this.activeChannelId()] ?? [],
  );
  readonly threadDraft = signal<string>('');

  selectChannel(id: string): void {
    this.activeChannelId.set(id);
    this.threadDraft.set('');
  }

  onMessageSent(text: string): void {
    const channelId = this.activeChannelId();
    this.messagesByChannel.update((byChannel) => ({
      ...byChannel,
      [channelId]: [
        ...(byChannel[channelId] ?? []),
        { id: `${channelId}-${Date.now()}`, author: 'You', text, sentAt: Date.now(), own: true },
      ],
    }));
  }
}
