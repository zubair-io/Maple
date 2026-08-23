// MuiThreadPanel — Maple UI Organisms (unified-component-catalog.md §4.3
// "Inspectors & panels"). Reply thread — built from Chat Message, Input,
// Button.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiChatMessageComponent } from '../chat-message/mui-chat-message.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiInputComponent } from '../input/mui-input.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';

export interface MuiThreadMessage {
  readonly id: string;
  readonly author: string;
  readonly sentAt: Date | number;
  readonly text: string;
  readonly own?: boolean;
}

@Component({
  selector: 'mui-thread-panel',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiChatMessageComponent,
    MuiEmptyStateComponent,
    MuiInputComponent,
    MuiSpinnerComponent,
  ],
  templateUrl: './mui-thread-panel.component.html',
  styleUrl: './mui-thread-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiThreadPanelComponent {
  readonly messages = input.required<readonly MuiThreadMessage[]>();
  readonly loading = input<boolean>(false);
  readonly sending = input<boolean>(false);
  readonly draft = model<string>('');

  readonly sent = output<string>();

  send(): void {
    const text = this.draft().trim();
    if (text.length === 0 || this.sending()) return;
    this.sent.emit(text);
    this.draft.set('');
  }
}
