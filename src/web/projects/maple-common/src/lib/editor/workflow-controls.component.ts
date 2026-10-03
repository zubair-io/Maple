import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  type TemplateRef,
} from '@angular/core';
import { EditorStateService } from './editor-state.service';
import {
  EditorWorkflowCommandsService,
  type WorkflowDocument,
  type SnapshotCommand,
  type RestoreCommand,
} from './editor-workflow-commands.service';
import type { WorkflowEdit } from './editor-workflow-history.service';
import { MuiButtonComponent } from '../ui/button/mui-button.component';
import { MuiOverlayShellComponent } from '../ui/overlay-shell/mui-overlay-shell.component';
import { MuiDialogComponent } from '../ui/dialog/mui-dialog.component';
import { MuiListRowComponent } from '../ui/list-row/mui-list-row.component';
import { MuiTextComponent } from '../ui/text/mui-text.component';
import { MuiSpinnerComponent } from '../ui/spinner/mui-spinner.component';
import { MuiEmptyStateComponent } from '../ui/empty-state/mui-empty-state.component';
import { errorMessage } from '../util/errors';
import {
  EditorWorkflowVariantsService,
  type CreateVariantCommand,
} from './editor-workflow-variants.service';
import type { WorkflowVariantSidecar } from '../xmp/workflow-variant-store.service';

@Component({
  selector: 'editor-workflow-controls',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiOverlayShellComponent,
    MuiDialogComponent,
    MuiListRowComponent,
    MuiTextComponent,
    MuiSpinnerComponent,
    MuiEmptyStateComponent,
  ],
  templateUrl: './workflow-controls.component.html',
  styleUrl: './workflow-controls.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents', '(keydown)': 'containKeyboard($event)' },
})
export class WorkflowControlsComponent {
  readonly editor: EditorStateService = inject(EditorStateService);
  readonly triggerTemplate = viewChild<TemplateRef<unknown>>('triggerTemplate');
  private readonly trigger = viewChild<MuiButtonComponent>('trigger');
  private readonly commands: EditorWorkflowCommandsService = inject(EditorWorkflowCommandsService);
  private readonly variantCommands = inject(EditorWorkflowVariantsService);
  readonly view = signal<'closed' | 'list' | 'snapshot' | 'restore' | 'variant'>('closed');
  readonly branches = signal<readonly WorkflowVariantSidecar[]>([]);
  readonly source = signal<WorkflowEdit | null>(null);
  readonly document = signal<WorkflowDocument | null>(null);
  readonly working = signal(false);
  readonly error = signal<string | null>(null);
  readonly name = signal('');
  readonly selectedLabel = signal('');
  readonly busy = computed(
    () =>
      this.working() ||
      this.editor.workflowBusy() ||
      this.editor.autoInFlight() ||
      this.editor.wbSampleInFlight(),
  );
  readonly versions = computed(() => {
    const record = this.document()?.record;
    return [
      ...(record?.snapshots ?? []).map((entry) => ({
        id: entry.id,
        label: `Snapshot: ${entry.name}`,
        timestamp: entry.createdAtMs,
      })),
      ...[...(record?.history ?? [])]
        .reverse()
        .map((entry) => ({ id: entry.id, label: entry.label, timestamp: entry.createdAtMs })),
    ];
  });
  private snapshot: SnapshotCommand | null = null;
  private restore: RestoreCommand | null = null;
  private operation = 0;
  private variant: CreateVariantCommand | null = null;

  constructor() {
    effect(() => {
      const source = this.source();
      const id = this.editor.imageId();
      if (source && (id !== source.id || !this.commands.history.isCurrent(source)))
        untracked(() => this.reset());
    });
  }

  async open(): Promise<void> {
    if (this.busy()) return;
    this.editor.endEdit();
    const id = this.editor.imageId();
    const model = this.editor.currentAdjustment();
    this.source.set(id && model ? this.commands.capture(id, model) : null);
    this.view.set('list');
    await this.reload();
  }

  async reload(): Promise<void> {
    if (this.busy()) return;
    const source = this.source();
    if (!source) {
      this.error.set(
        'Reopen this photo from a folder with write access to use portable snapshots and history.',
      );
      return;
    }
    this.snapshot = null;
    this.restore = null;
    this.editor.workflowReplay = null;
    await this.run(async (current) => {
      const document = await this.commands.load(source);
      const branches = await this.variantCommands.list(source);
      if (current()) {
        this.document.set(document);
        this.branches.set(branches);
      }
    });
  }

  close(): void {
    if (!this.busy()) {
      this.reset();
      queueMicrotask(() => this.trigger()?.focus());
    }
  }

  newSnapshot(): void {
    if (this.busy()) return;
    this.snapshot = null;
    this.name.set('');
    this.error.set(null);
    this.view.set('snapshot');
  }

  newVariant(): void {
    if (this.busy()) return;
    this.variant = null;
    this.name.set('');
    this.error.set(null);
    this.view.set('variant');
  }

  async saveVariant(): Promise<void> {
    const source = this.source();
    if (!source || this.busy()) return;
    await this.run(async (current) => {
      if (!this.variant || this.variant.workflow.variantName !== this.name().trim())
        this.variant = await this.variantCommands.prepareCreate(source, this.name());
      const branch = await this.variantCommands.create(this.variant);
      if (!current()) return;
      await this.variantCommands.select(source, branch.variantId);
      this.reset();
    });
  }

  async selectVariant(variantId: string): Promise<void> {
    const source = this.source();
    if (!source || this.busy() || source.variantId === variantId) return;
    await this.run(async (current) => {
      await this.variantCommands.select(source, variantId);
      if (current()) this.reset();
    });
  }

  async saveSnapshot(): Promise<void> {
    const source = this.source();
    if (!source || this.busy()) return;
    await this.run(async (current) => {
      if (!this.snapshot || this.snapshot.snapshot.name !== this.name().trim())
        this.snapshot = await this.commands.prepareSnapshot(source, this.name());
      const xml = await this.commands.saveSnapshot(this.snapshot);
      const document = await this.commands.load(source);
      if (!current() || !this.commands.history.isCurrent(source)) return;
      this.document.set(document);
      this.snapshot = null;
      this.view.set('list');
      void this.editor.announcer.announce('Snapshot saved');
      // `xml` is the confirmed server/filesystem publication, not an optimistic draft.
      if (!xml) throw Error('The snapshot publication is missing. Reload history.');
    });
  }

  async selectRestore(id: string): Promise<void> {
    const source = this.source();
    const document = this.document();
    if (!source || !document || this.busy()) return;
    await this.run(async (current) => {
      const restore = await this.commands.prepareRestore(source, document, id);
      if (!current()) return;
      this.restore = restore;
      this.selectedLabel.set(this.versions().find((entry) => entry.id === id)?.label ?? 'Version');
      this.view.set('restore');
    });
  }

  async confirmRestore(): Promise<void> {
    const command = this.restore;
    if (!command || this.busy()) return;
    await this.run(async (current) => {
      await this.editor.restoreWorkflow(command);
      const document = await this.commands.load(command.source);
      if (!current() || !this.commands.history.isCurrent(command.source)) return;
      this.document.set(document);
      this.restore = null;
      this.view.set('list');
    });
  }

  back(): void {
    if (this.busy()) return;
    this.snapshot = null;
    this.restore = null;
    this.variant = null;
    this.error.set(null);
    this.view.set('list');
  }

  containKeyboard(event: KeyboardEvent): void {
    if (this.view() === 'closed') return;
    if (event.key === 'Escape') {
      if (this.view() === 'list') this.close();
      else this.back();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Tab') this.trapModalTab(event);
    event.stopPropagation();
  }

  private trapModalTab(event: KeyboardEvent): void {
    const panel = (event.target as HTMLElement).closest('[role="dialog"]');
    const focusables = panel?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables?.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const boundary = event.shiftKey ? event.target === first : event.target === last;
    if (event.target === panel || boundary) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  private async run(action: (current: () => boolean) => Promise<void>): Promise<void> {
    const operation = ++this.operation;
    this.working.set(true);
    this.error.set(null);
    try {
      await action(() => this.operation === operation);
    } catch (error) {
      if (this.operation === operation) this.error.set(errorMessage(error));
    } finally {
      if (this.operation === operation) this.working.set(false);
    }
  }
  private reset(): void {
    this.operation += 1;
    this.working.set(false);
    this.view.set('closed');
    this.source.set(null);
    this.document.set(null);
    this.branches.set([]);
    this.error.set(null);
    this.snapshot = null;
    this.restore = null;
    this.variant = null;
  }
}
