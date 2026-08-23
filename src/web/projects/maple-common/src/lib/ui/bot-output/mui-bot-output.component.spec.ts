import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiBotOutputComponent } from './mui-bot-output.component';

function render(): ComponentFixture<MuiBotOutputComponent> {
  TestBed.configureTestingModule({ imports: [MuiBotOutputComponent] });
  const fixture = TestBed.createComponent(MuiBotOutputComponent);
  fixture.componentRef.setInput('text', 'Generating summary');
  fixture.componentRef.setInput('botName', 'Maple AI');
  fixture.detectChanges();
  return fixture;
}

describe('MuiBotOutputComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the full text immediately when not streaming', () => {
    const fixture = render();
    expect(fixture.componentInstance.visibleText()).toBe('Generating summary');
    expect(fixture.nativeElement.querySelector('mui-progress')).toBeNull();
  });

  it('reveals text progressively while streaming and emits completed once done', () => {
    const fixture = render();
    fixture.componentRef.setInput('streaming', true);
    fixture.componentRef.setInput('charsPerTick', 4);
    fixture.componentRef.setInput('intervalMs', 10);
    fixture.detectChanges();

    expect(fixture.componentInstance.visibleText()).toBe('');
    expect(fixture.nativeElement.querySelector('mui-progress')).toBeTruthy();

    let completedCount = 0;
    fixture.componentInstance.completed.subscribe(() => completedCount++);

    vi.advanceTimersByTime(10);
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleText()).toBe('Gene');

    // 'Generating summary' is 18 chars; 4/tick needs 5 ticks (20 clamps to 18).
    vi.advanceTimersByTime(40);
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleText()).toBe('Generating summary');
    expect(completedCount).toBe(1);
    expect(fixture.nativeElement.querySelector('mui-progress')).toBeNull();

    // No further ticks fire once fully revealed.
    vi.advanceTimersByTime(100);
    expect(completedCount).toBe(1);
  });

  it('restarting streaming on a new text value resets the reveal from empty', () => {
    const fixture = render();
    fixture.componentRef.setInput('streaming', true);
    fixture.componentRef.setInput('intervalMs', 10);
    fixture.detectChanges();
    vi.advanceTimersByTime(20);
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleLength()).toBeGreaterThan(0);

    fixture.componentRef.setInput('text', 'New reply text');
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleLength()).toBe(0);
  });
});
