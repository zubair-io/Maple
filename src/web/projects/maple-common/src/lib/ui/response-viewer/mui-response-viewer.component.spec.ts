import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiResponseViewerComponent } from './mui-response-viewer.component';

function render(): ComponentFixture<MuiResponseViewerComponent> {
  TestBed.configureTestingModule({ imports: [MuiResponseViewerComponent] });
  const fixture = TestBed.createComponent(MuiResponseViewerComponent);
  fixture.componentRef.setInput('status', 200);
  fixture.componentRef.setInput('statusText', 'OK');
  fixture.componentRef.setInput('body', '{ "ok": true }');
  fixture.componentRef.setInput('headers', 'content-type: application/json');
  fixture.detectChanges();
  return fixture;
}

describe('MuiResponseViewerComponent', () => {
  it('renders the status badge and body content by default', () => {
    const fixture = render();
    expect(fixture.nativeElement.textContent).toContain('200 OK');
    expect(fixture.nativeElement.textContent).toContain('{ "ok": true }');
  });

  it('switches to headers content when the Headers tab is selected', () => {
    const fixture = render();
    const tabs = fixture.nativeElement.querySelectorAll('.mui-tabs button, [role="tab"]');
    const headersTab = Array.from(tabs).find((el) =>
      (el as HTMLElement).textContent?.includes('Headers'),
    ) as HTMLElement;
    headersTab.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('content-type: application/json');
    expect(fixture.componentInstance.activeId()).toBe('headers');
  });

  it('uses the count badge variant for a non-2xx status', () => {
    const fixture = render();
    fixture.componentRef.setInput('status', 500);
    fixture.componentRef.setInput('statusText', 'Internal Error');
    fixture.detectChanges();
    expect(fixture.componentInstance.statusVariant()).toBe('count');
  });
});
