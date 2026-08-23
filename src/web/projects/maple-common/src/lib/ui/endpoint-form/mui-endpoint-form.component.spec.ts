import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiEndpointFormComponent } from './mui-endpoint-form.component';

function render(): ComponentFixture<MuiEndpointFormComponent> {
  TestBed.configureTestingModule({ imports: [MuiEndpointFormComponent] });
  const fixture = TestBed.createComponent(MuiEndpointFormComponent);
  fixture.componentRef.setInput('url', '/api/photos');
  fixture.detectChanges();
  return fixture;
}

describe('MuiEndpointFormComponent', () => {
  it('defaults to GET and marks it pressed', () => {
    const fixture = render();
    const buttons = fixture.nativeElement.querySelectorAll('.method');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking a method selects it', () => {
    const fixture = render();
    const buttons = fixture.nativeElement.querySelectorAll('.method');
    (buttons[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.method()).toBe('POST');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('emits send with the current method and url', () => {
    const fixture = render();
    const sent: Array<{ method: string; url: string }> = [];
    fixture.componentInstance.send.subscribe((req) => sent.push(req));

    const buttons = fixture.nativeElement.querySelectorAll('.method');
    (buttons[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('mui-button .mui-button') as HTMLButtonElement).click();
    expect(sent).toEqual([{ method: 'POST', url: '/api/photos' }]);
  });
});
