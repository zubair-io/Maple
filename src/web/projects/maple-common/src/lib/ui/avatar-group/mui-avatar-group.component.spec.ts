import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiAvatarGroupComponent, type MuiAvatarGroupMember } from './mui-avatar-group.component';

const MEMBERS: readonly MuiAvatarGroupMember[] = [
  { name: 'Jules' },
  { name: 'Sarah' },
  { name: 'Sam' },
  { name: 'Kim' },
  { name: 'Lee' },
];

describe('MuiAvatarGroupComponent', () => {
  it('renders every avatar with no overflow badge when the list fits under max', () => {
    const fixture = TestBed.createComponent(MuiAvatarGroupComponent);
    fixture.componentRef.setInput('avatars', MEMBERS.slice(0, 2));
    fixture.componentRef.setInput('max', 3);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('mui-avatar').length).toBe(2);
    expect(fixture.nativeElement.querySelector('mui-badge')).toBeNull();
  });

  it('caps visible avatars at max and shows a "+N" overflow badge for the rest', () => {
    const fixture = TestBed.createComponent(MuiAvatarGroupComponent);
    fixture.componentRef.setInput('avatars', MEMBERS);
    fixture.componentRef.setInput('max', 2);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('mui-avatar').length).toBe(2);
    const badge = fixture.nativeElement.querySelector('mui-badge .mui-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent.trim()).toBe('+3');
    expect(fixture.componentInstance.overflowCount()).toBe(3);
  });

  it('stacks every avatar after the first with a negative overlap margin', () => {
    const fixture = TestBed.createComponent(MuiAvatarGroupComponent);
    fixture.componentRef.setInput('avatars', MEMBERS.slice(0, 3));
    fixture.componentRef.setInput('max', 5);
    fixture.detectChanges();

    const slots = fixture.nativeElement.querySelectorAll('.slot');
    expect(slots[0].className).not.toContain('stacked');
    expect(slots[1].className).toContain('stacked');
    expect(slots[2].className).toContain('stacked');
  });
});
