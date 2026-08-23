import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSetupWizardComponent } from './mui-setup-wizard.component';
import { MuiWizardStepDirective } from './mui-wizard-step.directive';

@Component({
  standalone: true,
  imports: [MuiSetupWizardComponent, MuiWizardStepDirective],
  template: `
    <mui-setup-wizard
      [steps]="steps"
      [(stepIndex)]="stepIndex"
      [canGoNext]="canGoNext()"
      (stepChanged)="lastStepChanged = $event"
      (finished)="finishedCount = finishedCount + 1"
    >
      <ng-template muiWizardStep>
        <div class="probe-0">Account details</div>
      </ng-template>
      <ng-template muiWizardStep>
        <div class="probe-1">Storage location</div>
      </ng-template>
    </mui-setup-wizard>
  `,
})
class HostComponent {
  readonly steps = ['Account', 'Storage'];
  readonly stepIndex = signal(0);
  readonly canGoNext = signal(true);
  lastStepChanged: number | null = null;
  finishedCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

function nextButton(el: HTMLElement): HTMLButtonElement {
  return el.querySelector('.footer mui-button:last-child .mui-button') as HTMLButtonElement;
}

function backButton(el: HTMLElement): HTMLButtonElement {
  return el.querySelector('.footer mui-button:first-child .mui-button') as HTMLButtonElement;
}

describe('MuiSetupWizardComponent', () => {
  it('projects the active step template and swaps it on stepChanged', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.probe-0')).toBeTruthy();
    expect(el.querySelector('.probe-1')).toBeNull();

    nextButton(el).click();
    fixture.detectChanges();

    expect(host.stepIndex()).toBe(1);
    expect(host.lastStepChanged).toBe(1);
    expect(el.querySelector('.probe-0')).toBeNull();
    expect(el.querySelector('.probe-1')).toBeTruthy();
  });

  it('disables the Next button and blocks advancing while canGoNext is false', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    host.canGoNext.set(false);
    fixture.detectChanges();

    expect(nextButton(el).disabled).toBe(true);
    nextButton(el).click();
    fixture.detectChanges();

    expect(host.stepIndex()).toBe(0);
    expect(host.lastStepChanged).toBeNull();
  });

  it('moves back a step and disables Back on the first step', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(backButton(el).disabled).toBe(true);

    host.stepIndex.set(1);
    fixture.detectChanges();
    expect(backButton(el).disabled).toBe(false);

    backButton(el).click();
    fixture.detectChanges();
    expect(host.stepIndex()).toBe(0);
    expect(host.lastStepChanged).toBe(0);
  });

  it('shows Finish on the last step and emits finished instead of stepChanged', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    host.stepIndex.set(1);
    fixture.detectChanges();

    expect(nextButton(el).textContent?.trim()).toBe('Finish');
    nextButton(el).click();
    fixture.detectChanges();

    expect(host.finishedCount).toBe(1);
    expect(host.lastStepChanged).toBeNull();
  });
});
