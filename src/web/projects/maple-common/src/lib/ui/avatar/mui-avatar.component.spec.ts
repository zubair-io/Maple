import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiAvatarComponent } from './mui-avatar.component';

function render(name: string): ComponentFixture<MuiAvatarComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [MuiAvatarComponent] });
  const fixture = TestBed.createComponent(MuiAvatarComponent);
  fixture.componentRef.setInput('name', name);
  fixture.detectChanges();
  return fixture;
}

describe('MuiAvatarComponent', () => {
  it('derives two-letter initials from a first + last name', () => {
    const fixture = render('Jane Doe');
    expect(fixture.componentInstance.initials()).toBe('JD');
    expect(fixture.nativeElement.querySelector('.fallback')?.textContent?.trim()).toBe('JD');
  });

  it('derives two-letter initials from a single-word name', () => {
    const fixture = render('Cher');
    expect(fixture.componentInstance.initials()).toBe('CH');
  });

  it('derives initials from the first and last of a multi-word name', () => {
    const fixture = render('Mary Jane Watson');
    expect(fixture.componentInstance.initials()).toBe('MW');
  });

  it('is deterministic: the same name always yields the same fallback color', () => {
    const a = render('Alex Rivera').componentInstance.fallbackColor();
    const b = render('Alex Rivera').componentInstance.fallbackColor();
    expect(a).toEqual(b);
  });

  it('gives different names a chance at different fallback colors', () => {
    const colors = new Set(
      ['Alex Rivera', 'Priya Singh', 'Chen Wei', 'Sam Okafor', 'Lina Popescu'].map(
        (name) => render(name).componentInstance.fallbackColor().bg,
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it('shows the photo when `src` is set, and falls back to initials on load error', () => {
    const fixture = render('Jane Doe');
    fixture.componentRef.setInput('src', 'jane.jpg');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.photo')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.fallback')).toBeNull();

    (fixture.nativeElement.querySelector('.photo') as HTMLImageElement).dispatchEvent(
      new Event('error'),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.photo')).toBeNull();
    expect(fixture.nativeElement.querySelector('.fallback')?.textContent?.trim()).toBe('JD');
  });

  it('renders an optional presence dot', () => {
    const fixture = render('Jane Doe');
    expect(fixture.nativeElement.querySelector('.presence')).toBeNull();

    fixture.componentRef.setInput('presence', 'online');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.presence-online')).toBeTruthy();
  });

  it('reflects the size input as a class', () => {
    const fixture = render('Jane Doe');
    fixture.componentRef.setInput('size', 'lg');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-avatar').className).toContain('size-lg');
  });
});
