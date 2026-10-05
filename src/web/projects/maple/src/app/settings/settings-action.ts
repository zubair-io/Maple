import { signal } from '@angular/core';
import { errorMessage } from '@maple-common';

/** Serializes settings mutations and keeps their result local to the page. */
export class SettingsAction {
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');

  constructor(private readonly completed: () => void) {}

  async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      await action();
      this.completed();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
