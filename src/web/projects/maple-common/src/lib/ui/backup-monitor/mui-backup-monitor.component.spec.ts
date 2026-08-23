import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiBackupConfig, MuiBackupResult } from './mui-backup-monitor.component';
import { MuiBackupMonitorComponent } from './mui-backup-monitor.component';

@Component({
  standalone: true,
  imports: [MuiBackupMonitorComponent],
  template: `
    <mui-backup-monitor
      [running]="running()"
      [progress]="progress()"
      [lastResult]="lastResult()"
      (configChanged)="lastConfig = $event"
      (backupStartRequested)="startCount = startCount + 1"
    />
  `,
})
class HostComponent {
  readonly running = signal(false);
  readonly progress = signal<number | null>(null);
  readonly lastResult = signal<MuiBackupResult | null>(null);
  lastConfig: MuiBackupConfig | null = null;
  startCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiBackupMonitorComponent', () => {
  it('shows no banner and no progress bar by default', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('mui-banner')).toBeNull();
    expect(el.querySelector('mui-progress')).toBeNull();
  });

  it('switches the banner variant based on lastResult (success vs error)', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;

    host.lastResult.set({ message: 'Backup completed', variant: 'success' });
    fixture.detectChanges();
    expect(el.querySelector('.mui-banner.variant-success')?.textContent).toContain(
      'Backup completed',
    );

    host.lastResult.set({ message: 'Backup failed: destination unreachable', variant: 'error' });
    fixture.detectChanges();
    expect(el.querySelector('.mui-banner.variant-error')?.textContent).toContain(
      'destination unreachable',
    );
  });

  it('shows the progress bar only while running, and disables Run while running', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    const runButton = () => el.querySelector('.run .mui-button') as HTMLButtonElement;

    expect(runButton().disabled).toBe(false);

    host.running.set(true);
    host.progress.set(42);
    fixture.detectChanges();

    expect(el.querySelector('mui-progress')).toBeTruthy();
    expect(runButton().disabled).toBe(true);
  });

  it('emits backupStartRequested when Run backup now is pressed', () => {
    const { fixture, host } = render();
    (fixture.nativeElement.querySelector('.run .mui-button') as HTMLButtonElement).click();
    expect(host.startCount).toBe(1);
  });

  it('emits configChanged with both current field values when either field commits', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    const destinationInput = el.querySelectorAll('.fields input')[0] as HTMLInputElement;
    destinationInput.value = '/Volumes/MapleNAS/backups';
    destinationInput.dispatchEvent(new Event('input'));
    destinationInput.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(host.lastConfig).toEqual({
      destinationPath: '/Volumes/MapleNAS/backups',
      schedule: '',
    });

    const scheduleInput = el.querySelectorAll('.fields input')[1] as HTMLInputElement;
    scheduleInput.value = 'Weekly on Sunday';
    scheduleInput.dispatchEvent(new Event('input'));
    scheduleInput.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(host.lastConfig).toEqual({
      destinationPath: '/Volumes/MapleNAS/backups',
      schedule: 'Weekly on Sunday',
    });
  });
});
