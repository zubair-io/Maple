import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSliderComponent } from './mui-slider.component';

function render(): ComponentFixture<MuiSliderComponent> {
  TestBed.configureTestingModule({ imports: [MuiSliderComponent] });
  const fixture = TestBed.createComponent(MuiSliderComponent);
  fixture.componentRef.setInput('label', 'Exposure');
  fixture.componentRef.setInput('value', 0.3);
  fixture.componentRef.setInput('min', -2);
  fixture.componentRef.setInput('max', 2);
  fixture.componentRef.setInput('step', 0.1);
  fixture.detectChanges();
  return fixture;
}

function track(fixture: ComponentFixture<MuiSliderComponent>): HTMLInputElement {
  return fixture.nativeElement.querySelector('.track') as HTMLInputElement;
}

describe('MuiSliderComponent', () => {
  it('renders the label and a signed, formatted readout', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.label').textContent).toContain('Exposure');
    expect(fixture.nativeElement.querySelector('.readout').textContent.trim()).toBe('+0.3');
  });

  it('is a native range input reflecting min/max/step/value', () => {
    const fixture = render();
    const el = track(fixture);
    expect(el.type).toBe('range');
    expect(el.min).toBe('-2');
    expect(el.max).toBe('2');
    expect(el.step).toBe('0.1');
    expect(el.value).toBe('0.3');
  });

  it('updates the value model on native input events (covers keyboard/arrow operation)', () => {
    const fixture = render();
    const el = track(fixture);
    el.value = '1.1';
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(1.1);
    expect(fixture.nativeElement.querySelector('.readout').textContent.trim()).toBe('+1.1');
  });

  it('disables the control and dims the widget when disabled', () => {
    const fixture = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(track(fixture).disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.mui-slider').className).toContain('is-disabled');
  });

  describe('unsigned variant (min >= 0)', () => {
    function renderUnsigned(value = 50): ComponentFixture<MuiSliderComponent> {
      TestBed.configureTestingModule({ imports: [MuiSliderComponent] });
      const fixture = TestBed.createComponent(MuiSliderComponent);
      fixture.componentRef.setInput('label', 'Boundary Warp');
      fixture.componentRef.setInput('value', value);
      fixture.componentRef.setInput('unit', '%');
      fixture.detectChanges();
      return fixture;
    }

    it('reads 0-100 % as a plain value with the unit attached', () => {
      const fixture = renderUnsigned();
      expect(fixture.nativeElement.querySelector('.readout').textContent.trim()).toBe('50%');
      fixture.componentRef.setInput('value', 0);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.readout').textContent.trim()).toBe('0%');
    });

    it('speaks the value, with percent spelled out', () => {
      const fixture = renderUnsigned();
      expect(track(fixture).getAttribute('aria-valuetext')).toBe('50 percent');
    });

    it('speaks signed values with plus and minus', () => {
      const fixture = render();
      expect(track(fixture).getAttribute('aria-valuetext')).toBe('plus 0.3');
      fixture.componentRef.setInput('value', -0.3);
      fixture.detectChanges();
      expect(track(fixture).getAttribute('aria-valuetext')).toBe('minus 0.3');
    });
  });

  describe('helper line', () => {
    function status(fixture: ComponentFixture<MuiSliderComponent>): HTMLElement {
      return fixture.nativeElement.querySelector('[role="status"]') as HTMLElement;
    }

    it('always renders an empty status container when there is no helper', () => {
      const fixture = render();
      expect(status(fixture)).not.toBeNull();
      expect(status(fixture).textContent?.trim()).toBe('');
      expect(track(fixture).hasAttribute('aria-describedby')).toBe(false);
    });

    it('links a muted helper to the input and shows no warning icon', () => {
      const fixture = render();
      fixture.componentRef.setInput('helper', 'Stretches the edges toward a full rectangle.');
      fixture.detectChanges();
      expect(status(fixture).textContent).toContain('Stretches the edges');
      expect(track(fixture).getAttribute('aria-describedby')).toBe(status(fixture).id);
      expect(status(fixture).querySelector('mui-icon')).toBeNull();
    });

    it('renders a warning helper with a decorative icon, announced through the status role only', () => {
      const fixture = render();
      fixture.componentRef.setInput('helper', 'Not applied: the frames form separate pieces.');
      fixture.componentRef.setInput('helperTone', 'warning');
      fixture.detectChanges();
      expect(status(fixture).textContent).toContain('Not applied');
      expect(status(fixture).querySelector('mui-icon')?.getAttribute('aria-hidden')).toBe('true');
      expect(track(fixture).hasAttribute('aria-describedby')).toBe(false);
    });

    it('keeps the helper out of the dimmed region while disabled', () => {
      const fixture = render();
      fixture.componentRef.setInput('helper', 'Not applied.');
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();
      expect(status(fixture).closest('.mui-chrome-control-disabled')).toBeNull();
    });
  });

  describe('commit', () => {
    function setup(): { fixture: ComponentFixture<MuiSliderComponent>; commits: number[] } {
      const fixture = render();
      const commits: number[] = [];
      fixture.componentInstance.commit.subscribe((v) => commits.push(v));
      return { fixture, commits };
    }

    function drag(el: HTMLInputElement, ...values: string[]): void {
      for (const v of values) {
        el.value = v;
        el.dispatchEvent(new Event('input'));
      }
    }

    it('fires once with the final value when the drag ends, not on every step', () => {
      const { fixture, commits } = setup();
      const el = track(fixture);
      drag(el, '0.5', '0.9', '1.2');
      expect(commits).toEqual([]);
      el.dispatchEvent(new Event('change'));
      expect(commits).toEqual([1.2]);
    });

    it('does not fire when the drag ends where it began', () => {
      const { fixture, commits } = setup();
      const el = track(fixture);
      drag(el, '0.9', '0.3');
      el.dispatchEvent(new Event('change'));
      expect(commits).toEqual([]);
    });

    it('commits a cancelled drag, because the value already changed', () => {
      const { fixture, commits } = setup();
      const el = track(fixture);
      drag(el, '0.8');
      el.dispatchEvent(new Event('pointercancel'));
      el.dispatchEvent(new Event('change'));
      expect(commits).toEqual([0.8]);
    });

    it('commits once on key-up while an arrow key is held, not once per repeat', () => {
      const { fixture, commits } = setup();
      const el = track(fixture);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      for (const v of ['0.4', '0.5', '0.6']) {
        drag(el, v);
        el.dispatchEvent(new Event('change'));
      }
      expect(commits).toEqual([]);
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }));
      expect(commits).toEqual([0.6]);
    });

    it('commits a drag after Tab moved focus away and back, with no key-up on the slider', () => {
      const { fixture, commits } = setup();
      const el = track(fixture);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      el.dispatchEvent(new Event('blur'));
      drag(el, '0.8');
      el.dispatchEvent(new Event('change'));
      expect(commits).toEqual([0.8]);
    });

    it('does not suppress a drag commit because of a non-value key press', () => {
      const { fixture, commits } = setup();
      const el = track(fixture);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      drag(el, '0.8');
      el.dispatchEvent(new Event('change'));
      expect(commits).toEqual([0.8]);
    });

    it('finalizes a pending key change when focus leaves before the key-up', () => {
      const { fixture, commits } = setup();
      const el = track(fixture);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      drag(el, '0.4');
      el.dispatchEvent(new Event('blur'));
      expect(commits).toEqual([0.4]);
    });

    it('starts a fresh change after a commit', () => {
      const { fixture, commits } = setup();
      const el = track(fixture);
      drag(el, '1');
      el.dispatchEvent(new Event('change'));
      drag(el, '1.5');
      el.dispatchEvent(new Event('change'));
      expect(commits).toEqual([1, 1.5]);
    });
  });
});
