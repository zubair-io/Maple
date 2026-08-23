import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiCodeBlockComponent } from './mui-code-block.component';

describe('MuiCodeBlockComponent', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders the code text', () => {
    const fixture = TestBed.createComponent(MuiCodeBlockComponent);
    fixture.componentRef.setInput('code', 'const exposure = 0.0;');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('code').textContent).toBe('const exposure = 0.0;');
  });

  it('shows the language label and header copy button when a language is given', () => {
    const fixture = TestBed.createComponent(MuiCodeBlockComponent);
    fixture.componentRef.setInput('code', 'let x = 1;');
    fixture.componentRef.setInput('language', 'typescript');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.language').textContent).toBe('typescript');
    expect(fixture.nativeElement.querySelector('.header mui-button')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.floating-copy')).toBeNull();
  });

  it('copies the code to the clipboard and flips to a "Copied" state, then resets', async () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(MuiCodeBlockComponent);
    fixture.componentRef.setInput('code', 'const exposure = 0.0;');
    fixture.detectChanges();

    await fixture.componentInstance.copy();
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledWith('const exposure = 0.0;');
    expect(fixture.componentInstance.copied()).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(fixture.componentInstance.copied()).toBe(false);
  });

  it('stays un-copied when the clipboard write is rejected', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const fixture = TestBed.createComponent(MuiCodeBlockComponent);
    fixture.componentRef.setInput('code', 'x');
    fixture.detectChanges();

    await fixture.componentInstance.copy();

    expect(fixture.componentInstance.copied()).toBe(false);
  });

  it('clicking the floating copy button (no language given) triggers the same copy flow', async () => {
    const fixture = TestBed.createComponent(MuiCodeBlockComponent);
    fixture.componentRef.setInput('code', 'y');
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.floating-copy .mui-button');
    button.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('y');
  });
});
