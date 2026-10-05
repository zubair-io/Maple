import { DestroyRef, effect, inject, signal, untracked, type Signal } from '@angular/core';

type SettingsSaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

/** Seed once on load, then only on an explicit saved response; preserve draft edits. */
export function seedSettingsForm<T>(
  config: Signal<T | null>,
  seed: (value: T) => void,
): (value: T) => void {
  let seeded = false;
  const apply = (value: T): void => {
    seeded = true;
    untracked(() => seed(value));
  };
  effect(() => {
    const value = config();
    if (value !== null && !seeded) apply(value);
  });
  return apply;
}

/** Each save resource owns its acknowledgement timer, including on destruction. */
export class SettingsSaveStatus {
  private readonly status = signal<SettingsSaveState>({ kind: 'idle' });
  readonly state = this.status.asReadonly();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearTimer());
  }

  start(): void {
    this.clearTimer();
    this.status.set({ kind: 'saving' });
  }

  succeed(): void {
    this.clearTimer();
    this.status.set({ kind: 'saved' });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.status.set({ kind: 'idle' });
    }, 2000);
  }

  fail(message: string): void {
    this.clearTimer();
    this.status.set({ kind: 'error', message });
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
