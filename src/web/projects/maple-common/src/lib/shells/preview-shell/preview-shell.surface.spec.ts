import { describe, expect, it } from 'vitest';
import { setupFixture } from './preview-shell.test-helpers';

const RESOLVED = '[data-testid="preview-surface"] img[data-preview-resolved="true"]';

describe('preview surface observability', () => {
  it('opens the flag controls from the phone header', () => {
    const { fixture } = setupFixture();
    fixture.detectChanges();
    const flag = fixture.nativeElement.querySelector(
      '.preview-top-actions button[aria-label="Flag"]',
    ) as HTMLButtonElement;
    expect(flag).not.toBeNull();
    flag.click();
    fixture.detectChanges();
    expect(flag.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelector('#preview-flag-popover')).not.toBeNull();
  });

  it('does not mark a thumbnail as resolved before the preview subscription returns', () => {
    const { fixture } = setupFixture();
    fixture.componentInstance.thumbUrl.set('blob:thumbnail');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[data-preview-stage="thumbnail"]')).toHaveLength(
      1,
    );
    expect(fixture.nativeElement.querySelector(RESOLVED)).toBeNull();
  });

  it('marks a reused thumbnail resolved without inserting a duplicate image', () => {
    const { fixture } = setupFixture();
    fixture.componentInstance.thumbUrl.set('blob:thumbnail');
    fixture.componentInstance.previewUrl.set('blob:thumbnail');
    fixture.detectChanges();
    const images = fixture.nativeElement.querySelectorAll('[data-testid="preview-surface"] img');
    expect(images).toHaveLength(1);
    expect(fixture.nativeElement.querySelector(RESOLVED)).toBe(images[0]);
  });

  it('marks only the richer preview resolved when its URL differs', () => {
    const { fixture } = setupFixture();
    fixture.componentInstance.thumbUrl.set('blob:thumbnail');
    fixture.componentInstance.previewUrl.set('blob:preview');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelectorAll('[data-testid="preview-surface"] img'),
    ).toHaveLength(2);
    const ready = fixture.nativeElement.querySelectorAll(RESOLVED);
    expect(ready).toHaveLength(1);
    expect(ready[0].getAttribute('src')).toBe('blob:preview');
    expect(ready[0].getAttribute('data-preview-stage')).toBe('preview');
  });

  it('clears resolution when focus changes to another asset', () => {
    const { fixture, state } = setupFixture();
    fixture.componentInstance.thumbUrl.set('blob:thumbnail');
    fixture.componentInstance.previewUrl.set('blob:thumbnail');
    fixture.detectChanges();
    state.focusedAssetId.set('library:next.jpg');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(RESOLVED)).toBeNull();
  });
});
