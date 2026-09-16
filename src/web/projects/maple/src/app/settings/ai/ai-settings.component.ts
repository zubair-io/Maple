import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AiApiService,
  MuiButtonComponent,
  MuiInputComponent,
  MuiCheckboxComponent,
  MuiSettingsRowComponent,
  MuiSelectComponent,
} from '@maple-common';
import type { AiConnection, AiConnectionsResponse } from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';

@Component({
  selector: 'maple-ai-settings',
  standalone: true,
  imports: [
    SettingsShellComponent,
    MuiButtonComponent,
    MuiInputComponent,
    MuiCheckboxComponent,
    MuiSettingsRowComponent,
    MuiSelectComponent,
  ],
  templateUrl: './ai-settings.component.html',
  styleUrl: './ai-settings.component.scss',
  host: { class: 'set-vars set-page-host w-full' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiSettingsComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AiApiService);
  private readonly destroyRef = inject(DestroyRef);
  readonly config = signal<AiConnectionsResponse | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly dirty = signal(false);
  readonly message = signal('');
  readonly error = signal('');
  readonly models = signal<Record<string, string[]>>({});
  readonly probes = signal<Record<string, string>>({});
  readonly busy = signal<Record<string, boolean>>({});
  readonly expandedWorker = signal<string | null>(null);
  readonly expandedConnection = signal<string | null>(null);
  readonly providerOptions = [
    { value: 'ollama', label: 'Ollama' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'gemini', label: 'Gemini' },
  ];
  readonly customModels = signal<Record<string, boolean>>({});
  readonly customModelOption = '__custom_model__';
  modelChoices(worker: string, connection: AiConnection) {
    const current = this.connectionModel(worker, connection.id);
    const models = [
      ...new Set([...(current ? [current] : []), ...(this.models()[connection.id] ?? [])]),
    ];
    return [
      { value: '', label: 'Select a model' },
      ...models.map((model) => ({ value: model, label: model })),
      ...(connection.provider === 'ollama'
        ? [{ value: this.customModelOption, label: 'Enter model ID…' }]
        : []),
    ];
  }
  chooseModel(worker: string, id: string, model: string): void {
    if (model === this.customModelOption) {
      this.customModels.update((v) => ({ ...v, [worker + ':' + id]: true }));
      return;
    }
    this.setModel(worker, model, id);
  }
  closeCustomModel(worker: string, id: string): void {
    this.customModels.update((v) => ({ ...v, [worker + ':' + id]: false }));
  }
  private readonly revisions = new Map<string, number>();

  ngOnInit(): void {
    this.load();
  }
  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .getConnections()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (config) => {
          this.config.set(config);
          this.loading.set(false);
          const worker = this.expandedWorker() ?? this.route.snapshot.fragment;
          if (worker) this.setWorkerOpen(worker, true);
          this.dirty.set(Boolean(config.needs_save));
          this.message.set(
            config.needs_save
              ? 'Existing settings imported. Review and save to make worker assignments independent.'
              : '',
          );
        },
        error: () => {
          this.error.set('Could not load AI settings. Retry to continue.');
          this.loading.set(false);
        },
      });
  }
  addConnection(): void {
    const id = crypto.randomUUID();
    this.expandedConnection.set(id);
    this.config.update(
      (c) =>
        c && {
          ...c,
          connections: [
            ...c.connections,
            {
              id,
              name: 'New connection',
              provider: 'ollama',
              url: '',
              concurrency: 2,
            },
          ],
        },
    );
    this.changed();
  }
  updateConnection(id: string, patch: Partial<AiConnection>): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    this.config.update(
      (c) =>
        c && {
          ...c,
          connections: c.connections.map((v) => (v.id === id ? { ...v, ...patch } : v)),
        },
    );
    this.models.update((v) => ({ ...v, [id]: [] }));
    this.probes.update((v) => ({ ...v, [id]: '' }));
    this.busy.update((v) => ({ ...v, [id]: false }));
    this.changed();
  }
  providerChanged(id: string, provider: string): void {
    this.updateConnection(id, { provider, url: '', api_key: null, has_key: false });
    this.config.update(
      (c) =>
        c && {
          ...c,
          assignments: Object.fromEntries(
            Object.entries(c.assignments).map(([worker, a]) => [
              worker,
              a.connection_ids.includes(id)
                ? {
                    ...a,
                    model: a.connection_ids.filter((key) => key !== id).length ? a.model : '',
                    connection_models: Object.fromEntries(
                      a.connection_ids
                        .filter((key) => key !== id)
                        .map((key) => [key, a.connection_models?.[key] ?? a.model]),
                    ),
                    connection_ids: a.connection_ids.filter((key) => key !== id),
                  }
                : a,
            ]),
          ),
        },
    );
  }
  removeConnection(id: string): void {
    if (this.usedBy(id).length) return;
    this.config.update((c) => c && { ...c, connections: c.connections.filter((v) => v.id !== id) });
    this.changed();
  }
  usedBy(id: string): string[] {
    const c = this.config();
    return (
      c?.available_workers
        .filter((w) => c.assignments[w.id]?.connection_ids.includes(id))
        .map((w) => w.name) ?? []
    );
  }
  toggleConnection(worker: string, id: string, checked: boolean): void {
    this.config.update((c) => {
      if (!c) return c;
      const a = c.assignments[worker]!;
      const multiple = c.available_workers.find((w) => w.id === worker)?.multiple;
      const ids = checked
        ? [...new Set([...(multiple ? a.connection_ids : []), id])]
        : a.connection_ids.filter((key) => key !== id);
      const connection_models = Object.fromEntries(
        ids.map((key) => [
          key,
          a.connection_ids.includes(key) ? (a.connection_models?.[key] ?? a.model) : '',
        ]),
      );
      return {
        ...c,
        assignments: {
          ...c.assignments,
          [worker]: {
            model: connection_models[ids[0]!] ?? '',
            connection_ids: ids,
            connection_models,
          },
        },
      };
    });
    this.changed();
    const selected = this.config()?.connections.find((c) => c.id === id);
    if (checked && selected) this.probe(selected, true);
  }
  setWorkerOpen(worker: string, open: boolean): void {
    this.expandedWorker.set(open ? worker : null);
    const c = this.config();
    if (!open || !c) return;
    const ids = c.assignments[worker]?.connection_ids ?? [];
    c.connections
      .filter((connection) => ids.includes(connection.id))
      .filter((connection) => !this.busy()[connection.id])
      .forEach((connection) => this.probe(connection, true));
  }

  connectionModel(worker: string, id: string): string {
    const a = this.config()?.assignments[worker];
    return a?.connection_models ? (a.connection_models[id] ?? '') : (a?.model ?? '');
  }
  setModel(worker: string, model: string, id?: string): void {
    this.config.update((c) => {
      if (!c) return c;
      const a = c.assignments[worker]!;
      const key = id ?? a.connection_ids[0]!;
      const connection_models = Object.fromEntries(
        a.connection_ids.map((connectionId) => [
          connectionId,
          connectionId === key ? model : this.connectionModel(worker, connectionId),
        ]),
      );
      return {
        ...c,
        assignments: {
          ...c.assignments,
          [worker]: {
            ...a,
            model: connection_models[a.connection_ids[0]!] ?? '',
            connection_models,
          },
        },
      };
    });
    this.changed();
  }
  probe(connection: AiConnection, models: boolean): void {
    const revision = (this.revisions.get(connection.id) ?? 0) + 1;
    this.revisions.set(connection.id, revision);
    this.busy.update((v) => ({ ...v, [connection.id]: true }));
    this.api
      .probeConnection(connection, models)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          if (this.revisions.get(connection.id) !== revision) return;
          this.busy.update((v) => ({ ...v, [connection.id]: false }));
          if (result.models)
            this.models.update((v) => ({
              ...v,
              [connection.id]: result.error ? [] : result.models!,
            }));
          this.probes.update((v) => ({
            ...v,
            [connection.id]:
              result.error ??
              (models
                ? `${result.models?.length ?? 0} models available.`
                : 'Connection successful.'),
          }));
        },
        error: (err) => {
          if (this.revisions.get(connection.id) !== revision) return;
          this.busy.update((v) => ({ ...v, [connection.id]: false }));
          this.probes.update((v) => ({
            ...v,
            [connection.id]: err.error?.error ?? 'Connection failed.',
          }));
        },
      });
  }
  save(): void {
    const c = this.config();
    if (!c || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.api
      .saveConnections({ connections: c.connections, assignments: c.assignments })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (config) => {
          this.config.set(config);
          this.saving.set(false);
          this.dirty.set(false);
          this.message.set('AI settings saved. Workers will pick up the changes automatically.');
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(err.error?.error ?? 'Could not save AI settings.');
        },
      });
  }
  private changed(): void {
    this.dirty.set(true);
    this.message.set('');
    this.error.set('');
  }
}
