// MuiChatMessage — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// One message bubble, built from Avatar, Text, Timestamp.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MuiAvatarComponent } from '../avatar/mui-avatar.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiTimestampComponent } from '../timestamp/mui-timestamp.component';

@Component({
  selector: 'mui-chat-message',
  standalone: true,
  imports: [MuiAvatarComponent, MuiTextComponent, MuiTimestampComponent],
  templateUrl: './mui-chat-message.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiChatMessageComponent {
  readonly author = input.required<string>();
  readonly text = input.required<string>();
  readonly sentAt = input.required<Date | number>();
  /** Renders right-aligned, without a leading avatar, for the local user's
   * own messages. */
  readonly own = input<boolean>(false);

  /** `own` reverses the row and mirrors the bubble alignment — mutually
   * exclusive with the default layout, so this is one computed pair rather
   * than a static class racing a conditional add-on. */
  readonly rowClasses = computed(() => (this.own() ? 'flex-row-reverse' : ''));

  readonly bubbleClasses = computed(() =>
    this.own() ? 'bg-primary-dim items-end text-right' : 'bg-surface-alt',
  );
}
