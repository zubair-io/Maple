import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MuiRichTextEditorComponent, parseBlocks } from './mui-rich-text-editor.component';
import { MuiBubbleMenuComponent } from '../bubble-menu/mui-bubble-menu.component';

@Component({
  standalone: true,
  imports: [MuiRichTextEditorComponent],
  template: `<mui-rich-text-editor [(value)]="value" (commandExecuted)="lastCommand = $event" />`,
})
class HostComponent {
  readonly value = signal('<p>Hello</p>');
  lastCommand: string | null = null;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

/** Builds a minimal fake `Selection` good enough for the component's
 * `window.getSelection()` reads: `isCollapsed`, `rangeCount`,
 * `anchorNode`, and a `getRangeAt` returning a range-shaped object whose
 * `getBoundingClientRect` is a stub rect. */
function fakeSelection(options: {
  anchorNode: Node | null;
  isCollapsed: boolean;
  startContainer?: Node;
}): Selection {
  const range = {
    getBoundingClientRect: () =>
      ({ left: 10, top: 20, right: 30, bottom: 40, width: 20, height: 20 }) as DOMRect,
    cloneRange() {
      return this;
    },
    startContainer: options.startContainer ?? options.anchorNode,
  };
  return {
    isCollapsed: options.isCollapsed,
    rangeCount: options.anchorNode ? 1 : 0,
    anchorNode: options.anchorNode,
    getRangeAt: () => range,
  } as unknown as Selection;
}

describe('MuiRichTextEditorComponent', () => {
  let getSelectionSpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    getSelectionSpy?.mockRestore();
    getSelectionSpy = null;
  });

  it('syncs an external value into the contenteditable DOM on init', () => {
    const { fixture } = render();
    const editor = fixture.nativeElement.querySelector('.editor') as HTMLDivElement;
    expect(editor.innerHTML).toBe('<p>Hello</p>');
  });

  it('updates the value model when the user types (a real input event)', () => {
    const { fixture, host } = render();
    const editor = fixture.nativeElement.querySelector('.editor') as HTMLDivElement;

    editor.innerHTML = '<p>Hello world</p>';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    fixture.detectChanges();

    expect(host.value()).toBe('<p>Hello world</p>');
  });

  it('opens the bubble menu on a non-collapsed selection inside the editor', () => {
    const { fixture } = render();
    const editor = fixture.nativeElement.querySelector('.editor') as HTMLDivElement;
    const textNode = editor.firstChild!.firstChild!; // the "Hello" text node

    getSelectionSpy = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue(fakeSelection({ anchorNode: textNode, isCollapsed: false }));

    editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    fixture.detectChanges();

    const bubbleMenu = fixture.debugElement.query(
      (n) => n.componentInstance instanceof MuiBubbleMenuComponent,
    );
    expect(bubbleMenu).not.toBeNull();
    expect((bubbleMenu.componentInstance as MuiBubbleMenuComponent).open()).toBe(true);
  });

  it('closes the bubble menu when the selection collapses', () => {
    const { fixture } = render();
    const editor = fixture.nativeElement.querySelector('.editor') as HTMLDivElement;
    const textNode = editor.firstChild!.firstChild!;

    getSelectionSpy = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue(fakeSelection({ anchorNode: textNode, isCollapsed: false }));
    editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    fixture.detectChanges();

    getSelectionSpy.mockReturnValue(fakeSelection({ anchorNode: textNode, isCollapsed: true }));
    editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    fixture.detectChanges();

    const bubbleMenu = fixture.debugElement.query(
      (n) => n.componentInstance instanceof MuiBubbleMenuComponent,
    );
    expect((bubbleMenu.componentInstance as MuiBubbleMenuComponent).open()).toBe(false);
  });

  it('applies bold formatting to the current selection via the bubble menu', () => {
    const { fixture, host } = render();
    const editor = fixture.nativeElement.querySelector('.editor') as HTMLDivElement;
    const textNode = editor.firstChild!.firstChild! as Text;

    const range = document.createRange();
    range.selectNodeContents(textNode);
    getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: textNode,
      getRangeAt: () => range,
    } as unknown as Selection);

    const rte = fixture.debugElement.query(
      (n) => n.componentInstance instanceof MuiRichTextEditorComponent,
    ).componentInstance as MuiRichTextEditorComponent;
    rte.onFormat('bold');
    fixture.detectChanges();

    expect(host.value()).toContain('<strong>');
  });

  describe('parseBlocks', () => {
    it('returns a single text segment for plain HTML', () => {
      const blocks = parseBlocks('<p>Hello</p>');
      expect(blocks).toEqual([{ type: 'text', html: '<p>Hello</p>' }]);
    });

    it('splits out a fenced code block as its own segment', () => {
      const html =
        '<p>Before</p><pre class="rte-code-block" data-lang="text">// code</pre><p>After</p>';
      const blocks = parseBlocks(html);
      expect(blocks).toEqual([
        { type: 'text', html: '<p>Before</p>' },
        { type: 'code', content: '// code' },
        { type: 'text', html: '<p>After</p>' },
      ]);
    });

    it('returns an empty array for empty content', () => {
      expect(parseBlocks('')).toEqual([]);
      expect(parseBlocks('   ')).toEqual([]);
    });
  });
});
