import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedSettingsForm, SettingsSaveStatus } from './settings-form';

describe('settings form lifecycle', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('preserves a draft across config refreshes and applies a confirmed save response', () => {
    const config = signal<string | null>(null);
    const draft = signal('');
    const applySaved = TestBed.runInInjectionContext(() =>
      seedSettingsForm(config, (value) => draft.set(value)),
    );
    config.set('saved origin');
    TestBed.tick();
    expect(draft()).toBe('saved origin');
    draft.set('edited origin');
    config.set('refreshed origin');
    TestBed.tick();
    expect(draft()).toBe('edited origin');
    applySaved('normalized origin');
    TestBed.tick();
    expect(draft()).toBe('normalized origin');
  });

  it('keeps a new save pending when an earlier saved acknowledgement would expire', () => {
    vi.useFakeTimers();
    const status = TestBed.runInInjectionContext(() => new SettingsSaveStatus());
    status.succeed();
    vi.advanceTimersByTime(1000);
    status.start();
    vi.advanceTimersByTime(2000);
    expect(status.state()).toEqual({ kind: 'saving' });
    status.succeed();
    TestBed.resetTestingModule();
    vi.advanceTimersByTime(2000);
    expect(status.state()).toEqual({ kind: 'saved' });
  });
});
