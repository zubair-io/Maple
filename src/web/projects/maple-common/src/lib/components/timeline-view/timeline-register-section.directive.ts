// Tiny structural-style directive that registers an element with a
// caller-supplied callback. Used for month sections (DOM virtualisation)
// and the bottom fetch sentinel — lets a template express "call me back
// with my element" without inventing a `@ViewChildren` plumb.

import { Directive, ElementRef, OnInit, inject, input } from '@angular/core';

@Directive({
  selector: '[appTimelineRegisterSection]',
  standalone: true,
})
export class TimelineRegisterSectionDirective implements OnInit {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  appTimelineRegisterSection = input.required<(el: HTMLElement) => void>();

  ngOnInit(): void {
    this.appTimelineRegisterSection()(this.el.nativeElement);
  }
}
