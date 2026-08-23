import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import {
  MuiStructuredDataEditorComponent,
  type StructuredDataValue,
} from './mui-structured-data-editor.component';

@Component({
  standalone: true,
  imports: [MuiStructuredDataEditorComponent],
  template: `<mui-structured-data-editor [(value)]="value" (parseError)="lastError = $event" />`,
})
class HostComponent {
  readonly value = signal<StructuredDataValue>({ title: 'Sunset', rating: 4, favorite: true });
  lastError: string | null = null;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

function setCodeText(fixture: ComponentFixture<HostComponent>, text: string): void {
  const textarea = fixture.nativeElement.querySelector('.code-editor') as HTMLTextAreaElement;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
}

function switchToFormTab(fixture: ComponentFixture<HostComponent>): void {
  const formTabButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
    (btn) => (btn as HTMLButtonElement).textContent?.trim() === 'Form',
  ) as HTMLButtonElement;
  formTabButton.click();
  fixture.detectChanges();
}

describe('MuiStructuredDataEditorComponent', () => {
  it('renders the code textarea pre-filled with the current value as JSON', () => {
    const { fixture } = render();
    const textarea = fixture.nativeElement.querySelector('.code-editor') as HTMLTextAreaElement;
    expect(textarea.value).toContain('"title": "Sunset"');
  });

  it('valid JSON typed into the code tab updates the generated form fields', () => {
    const { fixture, host } = render();
    setCodeText(fixture, JSON.stringify({ a: '1', b: '2', c: '3' }));

    expect(host.value()).toEqual({ a: '1', b: '2', c: '3' });
    switchToFormTab(fixture);
    expect(fixture.nativeElement.querySelectorAll('mui-form-field').length).toBe(3);
  });

  it('committing a form field re-serializes the code text with the new value', () => {
    const { fixture, host } = render();
    switchToFormTab(fixture);

    const debugEl = fixture.debugElement.query(
      (n) => n.componentInstance instanceof MuiStructuredDataEditorComponent,
    );
    const editor = debugEl.componentInstance as MuiStructuredDataEditorComponent;
    editor.onFieldCommit('title', 'Sunrise');
    fixture.detectChanges();

    expect(host.value()['title']).toBe('Sunrise');
    expect(editor.codeText()).toContain('"title": "Sunrise"');
  });

  it('coerces a committed field back to its original type (number, boolean)', () => {
    const { fixture, host } = render();
    const debugEl = fixture.debugElement.query(
      (n) => n.componentInstance instanceof MuiStructuredDataEditorComponent,
    );
    const editor = debugEl.componentInstance as MuiStructuredDataEditorComponent;

    editor.onFieldCommit('rating', '5');
    editor.onFieldCommit('favorite', 'false');
    fixture.detectChanges();

    expect(host.value()['rating']).toBe(5);
    expect(typeof host.value()['rating']).toBe('number');
    expect(host.value()['favorite']).toBe(false);
    expect(typeof host.value()['favorite']).toBe('boolean');
  });

  it('invalid JSON sets a visible parse error and leaves the form fields untouched', () => {
    const { fixture, host } = render();
    const originalValue = host.value();

    setCodeText(fixture, '{ not valid json');

    const banner = fixture.nativeElement.querySelector('.error-banner');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBeTruthy();

    // The last-good value — and therefore the form fields it drives —
    // must be untouched by a failed parse.
    expect(host.value()).toBe(originalValue);
    switchToFormTab(fixture);
    expect(fixture.nativeElement.querySelectorAll('mui-form-field').length).toBe(3);
  });

  it('valid JSON that is not a flat object is also rejected without touching value', () => {
    const { fixture, host } = render();
    const originalValue = host.value();

    setCodeText(fixture, JSON.stringify({ nested: { a: 1 } }));

    expect(fixture.nativeElement.querySelector('.error-banner')).not.toBeNull();
    expect(host.value()).toBe(originalValue);
  });

  it('clears the error banner once valid JSON is typed again', () => {
    const { fixture } = render();
    setCodeText(fixture, '{ not valid');
    expect(fixture.nativeElement.querySelector('.error-banner')).not.toBeNull();

    setCodeText(fixture, JSON.stringify({ ok: 'yes' }));
    expect(fixture.nativeElement.querySelector('.error-banner')).toBeNull();
  });
});
