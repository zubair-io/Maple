// MuiRichTextEditor — Maple UI Organisms, Wave W6 Lane B "Editing surfaces"
// (unified-component-catalog.md §4.5). A real `contenteditable` document
// body with a selection-anchored Bubble Menu (Bold/Italic/Link) and a
// `/`-triggered Command Menu (Heading/Code block/Bulleted list), plus a
// read-only structured preview of any fenced code blocks the Command Menu
// inserted. Built from: Bubble Menu, Command Menu, Code Block.
//
// Icon-registry note: `MapleIconName` has no bold/italic/pen/heading glyph,
// so the bubble menu borrows the closest available approximations —
// 'edit' for Bold, 'tag' for Italic, 'share-up-square' for Link. This is a
// registry limitation, not a mislabel.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  MuiBubbleMenuComponent,
  type MuiBubbleMenuEntry,
} from '../bubble-menu/mui-bubble-menu.component';
import {
  MuiCommandMenuComponent,
  type MuiCommandItem,
} from '../command-menu/mui-command-menu.component';
import { MuiCodeBlockComponent } from '../code-block/mui-code-block.component';

/** One segment of the read-only structured preview rendered below the
 * editable region — either a raw HTML fragment or the content of one fenced
 * code block. */
export type RteBlock =
  | { readonly type: 'text'; readonly html: string }
  | { readonly type: 'code'; readonly content: string };

interface HostPoint {
  readonly x: number;
  readonly y: number;
}

const CODE_BLOCK_CLASS = 'rte-code-block';

const BUBBLE_ENTRIES: readonly MuiBubbleMenuEntry[] = [
  { id: 'bold', icon: 'edit', label: 'Bold' },
  { id: 'italic', icon: 'tag', label: 'Italic' },
  { id: 'link', icon: 'share-up-square', label: 'Link' },
];

const SLASH_COMMANDS: readonly MuiCommandItem[] = [
  { id: 'heading', label: 'Heading' },
  { id: 'code', label: 'Code block' },
  { id: 'bulleted-list', label: 'Bulleted list' },
];

/** Pure helper: splits raw editor HTML into an ordered array of text/code
 * segments. A code segment is any `<pre class="rte-code-block">` the
 * Command Menu's "Code block" entry inserted; everything else is one text
 * segment. Module-level (not a method) so it stays a plain, testable
 * function of its input string. */
export function parseBlocks(html: string): readonly RteBlock[] {
  if (html.trim().length === 0) return [];
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return [];

  const blocks: RteBlock[] = [];
  let textBuffer = '';
  const flushText = (): void => {
    if (textBuffer.trim().length > 0) blocks.push({ type: 'text', html: textBuffer });
    textBuffer = '';
  };

  for (const node of Array.from(root.childNodes)) {
    const isCodeBlock =
      node instanceof Element &&
      node.tagName === 'PRE' &&
      node.classList.contains(CODE_BLOCK_CLASS);
    if (isCodeBlock) {
      flushText();
      blocks.push({ type: 'code', content: node.textContent ?? '' });
    } else {
      textBuffer += node instanceof Element ? node.outerHTML : (node.textContent ?? '');
    }
  }
  flushText();
  return blocks;
}

@Component({
  selector: 'mui-rich-text-editor',
  standalone: true,
  imports: [MuiBubbleMenuComponent, MuiCommandMenuComponent, MuiCodeBlockComponent],
  templateUrl: './mui-rich-text-editor.component.html',
  styleUrl: './mui-rich-text-editor.component.scss',
  host: { class: 'relative flex flex-col gap-4' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiRichTextEditorComponent {
  /** The document body as an HTML string — the sidecar-facing state. */
  readonly value = model<string>('');
  /** Fires with the command id whenever a `/`-command inserts markup. */
  readonly commandExecuted = output<string>();

  private readonly hostRef = inject(ElementRef<HTMLElement>);
  readonly editorRef = viewChild<ElementRef<HTMLDivElement>>('editor');

  readonly bubbleMenuOpen = signal(false);
  readonly bubblePos = signal<HostPoint>({ x: 0, y: 0 });
  readonly bubbleEntries = BUBBLE_ENTRIES;

  readonly commandMenuOpen = signal(false);
  readonly commandPos = signal<HostPoint>({ x: 0, y: 0 });
  readonly commands = SLASH_COMMANDS;

  /** Read-only structured preview of the document's fenced code blocks. */
  readonly blocks = computed(() => parseBlocks(this.value()));

  private slashRange: Range | null = null;

  constructor() {
    effect(() => {
      const next = this.value();
      const el = this.editorRef()?.nativeElement;
      if (!el) return;
      // Guard against fighting the caret: an unconditional `innerHTML`
      // write on every change would reset the selection and clobber an
      // in-progress edit, including the write this same effect reacts to
      // right after `onInput` already applied it to the DOM. Comparing
      // first means only a genuinely external `value()` write (the caller
      // resetting content) actually touches the DOM.
      if (el.innerHTML !== next) el.innerHTML = next;
    });
  }

  onInput(event: Event): void {
    const target = event.target as HTMLDivElement;
    this.value.set(target.innerHTML);
    this.detectSlashCommand(target);
  }

  onSelectionChange(): void {
    const editor = this.editorRef()?.nativeElement;
    const selection = window.getSelection();
    if (!editor || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      this.bubbleMenuOpen.set(false);
      return;
    }
    const anchor = selection.anchorNode;
    if (!anchor || !editor.contains(anchor)) {
      this.bubbleMenuOpen.set(false);
      return;
    }
    const range = selection.getRangeAt(0);
    this.bubblePos.set(this.toHostRelative(range.getBoundingClientRect()));
    this.bubbleMenuOpen.set(true);
  }

  onFormat(id: string): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const wrapper = this.elementForFormat(id);
    if (!wrapper) return;
    try {
      range.surroundContents(wrapper);
    } catch {
      // `surroundContents` throws when the range partially selects a
      // non-text node (e.g. spans across element boundaries). Falling back
      // to extract-then-reinsert still produces the real wrapped markup.
      const fragment = range.extractContents();
      wrapper.appendChild(fragment);
      range.insertNode(wrapper);
    }
    this.bubbleMenuOpen.set(false);
    this.syncValueFromDom();
  }

  onCommandSelect(id: string): void {
    this.removeTypedSlash();
    const editor = this.editorRef()?.nativeElement;
    if (editor) this.applyCommand(id, editor);
    this.commandMenuOpen.set(false);
    this.syncValueFromDom();
    this.commandExecuted.emit(id);
  }

  private applyCommand(id: string, editor: HTMLDivElement): void {
    if (id === 'heading') {
      document.execCommand('formatBlock', false, 'H2');
      return;
    }
    if (id === 'bulleted-list') {
      document.execCommand('insertUnorderedList');
      return;
    }
    if (id === 'code') {
      const pre = document.createElement('pre');
      pre.className = CODE_BLOCK_CLASS;
      pre.dataset['lang'] = 'text';
      pre.textContent = '// code';
      editor.appendChild(pre);
    }
  }

  private elementForFormat(id: string): HTMLElement | null {
    if (id === 'bold') return document.createElement('strong');
    if (id === 'italic') return document.createElement('em');
    if (id === 'link') {
      const anchor = document.createElement('a');
      anchor.href = '#';
      return anchor;
    }
    return null;
  }

  private detectSlashCommand(editor: HTMLDivElement): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      this.commandMenuOpen.set(false);
      return;
    }
    const anchor = selection.anchorNode;
    if (!anchor || !editor.contains(anchor)) {
      this.commandMenuOpen.set(false);
      return;
    }
    const block = this.containingBlock(anchor, editor);
    if (block.textContent?.trim() !== '/') {
      this.commandMenuOpen.set(false);
      return;
    }
    const range = selection.getRangeAt(0);
    this.slashRange = range.cloneRange();
    this.commandPos.set(this.toHostRelative(range.getBoundingClientRect()));
    this.commandMenuOpen.set(true);
  }

  private removeTypedSlash(): void {
    const range = this.slashRange;
    this.slashRange = null;
    if (!range) return;
    const editor = this.editorRef()?.nativeElement;
    if (!editor) return;
    const block = this.containingBlock(range.startContainer, editor);
    if (block.textContent?.trim() === '/') block.textContent = '';
  }

  /** Walks up from `node` to its direct-child-of-`editor` ancestor — the
   * closest thing to "the current line" without a full block-model. */
  private containingBlock(node: Node, editor: HTMLDivElement): HTMLElement {
    let current: Node = node;
    while (current.parentNode && current.parentNode !== editor) {
      current = current.parentNode;
    }
    return current instanceof HTMLElement ? current : editor;
  }

  private toHostRelative(rect: DOMRect): HostPoint {
    const hostRect = this.hostRef.nativeElement.getBoundingClientRect();
    return { x: rect.left - hostRect.left, y: rect.top - hostRect.top };
  }

  private syncValueFromDom(): void {
    const el = this.editorRef()?.nativeElement;
    if (el) this.value.set(el.innerHTML);
  }
}
