import { expect, it } from 'vitest';
import { setupFixture, STUB_ASSET } from './preview-shell.test-helpers';
import { editRouteCommands } from '../../addressing/route-address';

function action(fixture: ReturnType<typeof setupFixture>['fixture'], label: string) {
  return [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      '.action-bar button',
    ),
  ].find((button) => button.textContent?.trim() === label)!;
}

it('stacked Flag discloses its actual region without acquiring toggle semantics', () => {
  const { fixture } = setupFixture();
  const flag = action(fixture, 'Flag');
  expect(flag.hasAttribute('aria-pressed')).toBe(false);
  expect(flag.getAttribute('aria-expanded')).toBe('false');
  flag.click();
  fixture.detectChanges();
  expect(flag.getAttribute('aria-expanded')).toBe('true');
  expect(
    fixture.nativeElement.querySelector('#' + flag.getAttribute('aria-controls')),
  ).not.toBeNull();
});

it('stacked Edit reaches the existing editor without acquiring toggle semantics', () => {
  const { fixture, navigate } = setupFixture();
  const edit = action(fixture, 'Edit');
  expect(edit.hasAttribute('aria-pressed')).toBe(false);
  edit.click();
  expect(navigate).toHaveBeenCalledWith(editRouteCommands(STUB_ASSET.id));
});

it('stacked Info retains its boolean pressed state and pane behavior', () => {
  const { fixture } = setupFixture({ layout: 'tablet' });
  const info = action(fixture, 'Info');
  expect(info.getAttribute('aria-pressed')).toBe('true');
  info.click();
  fixture.detectChanges();
  expect(info.getAttribute('aria-pressed')).toBe('false');
  expect(fixture.nativeElement.querySelector('.info-pane')).toBeNull();
});

it('focused Preview actions own their keys while surface navigation still works', () => {
  const { fixture, state } = setupFixture();
  const flag = action(fixture, 'Flag');
  for (const key of ['ArrowRight', 'ArrowLeft', '1', 'p']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    flag.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(state.focusNext).not.toHaveBeenCalled();
  expect(state.focusPrev).not.toHaveBeenCalled();
  expect(state.setRating).not.toHaveBeenCalled();
  expect(state.setFlag).not.toHaveBeenCalled();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(state.focusNext).toHaveBeenCalledOnce();
});

it('the filmstrip collapse control owns keys without paging photos', () => {
  const { fixture, state } = setupFixture();
  const toggle = fixture.nativeElement.querySelector(
    'editor-filmstrip .strip-toggle',
  ) as HTMLButtonElement;
  expect(toggle).not.toBeNull();
  toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(state.focusNext).not.toHaveBeenCalled();
});
