import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageSignInComponent } from './mui-page-sign-in.component';

describe('MuiPageSignInComponent', () => {
  it('renders two Form Fields and a Button, with no Banner until submit', () => {
    const fixture = TestBed.createComponent(MuiPageSignInComponent);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('mui-form-field').length).toBe(2);
    expect(el.querySelector('mui-button')).toBeTruthy();
    expect(el.querySelector('mui-banner')).toBeNull();
  });

  it('shows an error Banner when submitting with empty fields', () => {
    const fixture = TestBed.createComponent(MuiPageSignInComponent);
    fixture.detectChanges();

    fixture.componentInstance.onSubmit();
    fixture.detectChanges();

    expect(fixture.componentInstance.banner()?.variant).toBe('error');
    expect(fixture.nativeElement.querySelector('mui-banner')).toBeTruthy();
  });

  it('shows a success Banner naming the email once both fields are filled', () => {
    const fixture = TestBed.createComponent(MuiPageSignInComponent);
    fixture.detectChanges();

    fixture.componentInstance.email.set('ada@example.com');
    fixture.componentInstance.password.set('hunter2');
    fixture.componentInstance.onSubmit();
    fixture.detectChanges();

    expect(fixture.componentInstance.banner()?.variant).toBe('success');
    expect(fixture.componentInstance.banner()?.message).toContain('ada@example.com');
  });

  it('clears the Banner on dismiss', () => {
    const fixture = TestBed.createComponent(MuiPageSignInComponent);
    fixture.detectChanges();

    fixture.componentInstance.onSubmit();
    fixture.componentInstance.dismissBanner();
    fixture.detectChanges();

    expect(fixture.componentInstance.banner()).toBeNull();
  });
});
