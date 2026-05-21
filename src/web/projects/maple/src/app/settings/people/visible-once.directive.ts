// One-shot IntersectionObserver directive.
//
// Emits `mapleVisibleOnce` the first time the host element scrolls into
// the viewport (or starts in it), then disconnects. Used by the People
// grid so each card defers its thumbnail HTTP fetch until it's actually
// near-visible — native `<img loading="lazy">` only defers decode of
// already-fetched bytes, not the bearer-gated fetch itself, so we have
// to gate the upstream blob load this way.
//
// `rootMargin` is generous enough that fast scrolling pre-fetches a
// row or two of cards before they reach the fold, avoiding the visual
// pop-in.

import { AfterViewInit, Directive, ElementRef, OnDestroy, inject, output } from '@angular/core';

@Directive({
  standalone: true,
  selector: '[mapleVisibleOnce]',
})
export class MapleVisibleOnceDirective implements AfterViewInit, OnDestroy {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly mapleVisibleOnce = output<void>();
  private observer?: IntersectionObserver;

  ngAfterViewInit(): void {
    if (typeof IntersectionObserver === 'undefined') {
      // SSR / very old browser — fire immediately so the page still works.
      this.mapleVisibleOnce.emit();
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            this.mapleVisibleOnce.emit();
            this.observer?.disconnect();
            this.observer = undefined;
            return;
          }
        }
      },
      { rootMargin: '300px 0px' },
    );
    this.observer.observe(this.el.nativeElement);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
