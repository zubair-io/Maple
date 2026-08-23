import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiPipelineStage } from './mui-pipeline-monitor.component';
import { MuiPipelineMonitorComponent } from './mui-pipeline-monitor.component';

const STAGES: readonly MuiPipelineStage[] = [
  { id: 'exif', name: 'exif', status: 'done', processed: 100, total: 100 },
  { id: 'thumb', name: 'thumb', status: 'running', processed: 40, total: 100 },
  { id: 'describe', name: 'describe', status: 'error', processed: 10, total: 100 },
  { id: 'geocode', name: 'geocode', status: 'paused', processed: 0, total: 100 },
];

@Component({
  standalone: true,
  imports: [MuiPipelineMonitorComponent],
  template: `
    <mui-pipeline-monitor
      [stages]="stages()"
      (stagePauseToggled)="lastToggled = $event"
      (stageRetried)="lastRetried = $event"
    />
  `,
})
class HostComponent {
  readonly stages = signal<readonly MuiPipelineStage[]>(STAGES);
  lastToggled: string | null = null;
  lastRetried: string | null = null;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiPipelineMonitorComponent', () => {
  it('shows the empty state and no overall bar when there are no stages', () => {
    const { fixture, host } = render();
    host.stages.set([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-empty-state')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.overall')).toBeNull();
  });

  it('aggregates overall progress across all stages (150 / 400 = 38%)', () => {
    const { fixture } = render();
    expect(fixture.componentInstance).toBeTruthy();
    const monitor = fixture.debugElement.children[0]
      .componentInstance as MuiPipelineMonitorComponent;
    expect(monitor.overallProgress()).toBe(38);
  });

  it('renders one row per stage with a status badge', () => {
    const { fixture } = render();
    const rows = fixture.nativeElement.querySelectorAll('mui-list-row');
    expect(rows.length).toBe(4);
    const badges = Array.from(
      fixture.nativeElement.querySelectorAll('mui-badge .pill'),
    ) as HTMLElement[];
    expect(badges.map((b) => b.textContent?.trim())).toEqual([
      'Done',
      'Running',
      'Error',
      'Paused',
    ]);
  });

  it('emits stagePauseToggled for a running stage and stageRetried only for an error stage', () => {
    const { fixture, host } = render();
    const rows = fixture.nativeElement.querySelectorAll('mui-list-row');

    const runningButtons = rows[1].querySelectorAll(
      'mui-button .mui-button',
    ) as NodeListOf<HTMLButtonElement>;
    runningButtons[0].click();
    expect(host.lastToggled).toBe('thumb');

    const errorButtons = rows[2].querySelectorAll(
      'mui-button .mui-button',
    ) as NodeListOf<HTMLButtonElement>;
    expect(errorButtons.length).toBe(1);
    errorButtons[0].click();
    expect(host.lastRetried).toBe('describe');

    const doneButtons = rows[0].querySelectorAll('mui-button');
    expect(doneButtons.length).toBe(0);
  });
});
