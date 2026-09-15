// AiSettingsComponent — Dedicated AI settings surface at /settings/ai.
//
// Operator configuration for AI vision providers (Ollama, OpenAI, Anthropic, Gemini),
// testing connections, discovering available models via provider APIs, and
// mapping providers and models to workers (e.g. describe, video-describe).

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import {
  AiApiService,
  type AiConfigResponse,
  type AvailableWorker,
  type MuiSelectOption,
  MuiButtonComponent,
  MuiInputComponent,
  MuiSelectComponent,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';

export type AiProviderId = 'ollama' | 'openai' | 'anthropic' | 'gemini';

export interface ProviderMeta {
  readonly id: AiProviderId;
  readonly name: string;
  readonly badge: string;
  readonly description: string;
  readonly defaultModel: string;
}

export const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    badge: 'Local / Self-Hosted',
    description: 'Local or networked Ollama instance running open vision models.',
    defaultModel: 'gemma4:12b',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    badge: 'Cloud API',
    description: 'OpenAI GPT-4o and GPT-4o-mini multimodal vision models.',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    badge: 'Cloud API',
    description: 'Claude 3.5 and Claude 3.7 multimodal vision models.',
    defaultModel: 'claude-3-5-haiku-20241022',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    badge: 'Cloud API',
    description: 'Gemini 2.0 and Gemini 1.5 multimodal vision models.',
    defaultModel: 'gemini-2.0-flash',
  },
];

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

@Component({
  selector: 'maple-ai-settings',
  standalone: true,
  imports: [
    SettingsShellComponent,
    SettingsIconComponent,
    MuiButtonComponent,
    MuiInputComponent,
    MuiSelectComponent,
  ],
  templateUrl: './ai-settings.component.html',
  styleUrl: './ai-settings.component.scss',
  host: { class: 'set-vars set-page-host w-full' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiSettingsComponent implements OnInit {
  private readonly aiApi = inject(AiApiService);
  private readonly destroyRef = inject(DestroyRef);
  private modelRequest = 0;
  private connectionRequest = 0;

  readonly providers = PROVIDERS;
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly saveState = signal<SaveState>({ kind: 'idle' });

  readonly activeProvider = signal<AiProviderId>('ollama');

  // Provider credentials & endpoint inputs
  protected readonly fOllamaUrl = signal('http://localhost:11434');
  protected readonly fOpenAiKey = signal('');
  protected readonly hasOpenAiKey = signal(false);
  protected readonly fAnthropicKey = signal('');
  protected readonly hasAnthropicKey = signal(false);
  protected readonly fGeminiKey = signal('');
  protected readonly hasGeminiKey = signal(false);

  // Model discovery
  protected readonly modelsLoading = signal(false);
  protected readonly modelsError = signal<string | null>(null);
  protected readonly modelsByProvider = signal<Record<AiProviderId, string[]>>({
    ollama: ['gemma4:12b', 'qwen2.5-vl:7b', 'llava:latest'],
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'],
    anthropic: [
      'claude-3-5-haiku-20241022',
      'claude-3-5-sonnet-20241022',
      'claude-3-7-sonnet-20250219',
    ],
    gemini: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
  });
  readonly selectedModel = signal<string>('gemma4:12b');

  // Connection testing
  protected readonly testLoading = signal(false);
  protected readonly testResult = signal<{ ok: boolean; message: string } | null>(null);

  // Worker assignments
  protected readonly availableWorkers = signal<AvailableWorker[]>([
    { id: 'describe', name: 'Describe (Image Captioning & OCR)' },
    { id: 'video-describe', name: 'Video Describe (Video Summarization)' },
  ]);
  readonly workerAssignments = signal<Record<string, { provider: string; model: string }>>({
    describe: { provider: 'ollama', model: 'gemma4:12b' },
    'video-describe': { provider: 'ollama', model: 'gemma4:12b' },
  });

  protected readonly activeMeta = computed<ProviderMeta>(() => {
    return PROVIDERS.find((p) => p.id === this.activeProvider()) ?? PROVIDERS[0]!;
  });

  protected readonly currentModelOptions = computed<readonly MuiSelectOption[]>(() => {
    const list = this.modelsByProvider()[this.activeProvider()] ?? [];
    return list.map((m) => ({ value: m, label: m }));
  });

  ngOnInit(): void {
    this.loadConfig();
  }

  private applyLoadedProviders(providers: AiConfigResponse['providers']): void {
    const ollamaUrl = providers.ollama?.url;
    if (ollamaUrl) {
      this.fOllamaUrl.set(ollamaUrl);
    }
    this.hasOpenAiKey.set(Boolean(providers.openai?.has_key));
    this.hasAnthropicKey.set(Boolean(providers.anthropic?.has_key));
    this.hasGeminiKey.set(Boolean(providers.gemini?.has_key));
  }

  private applyLoadedWorkers(cfg: AiConfigResponse): void {
    const workers = cfg.workers;
    if (workers) {
      this.workerAssignments.set({ ...workers });
    }
    const avail = cfg.available_workers;
    if (avail && avail.length > 0) {
      this.availableWorkers.set(avail);
    }
    const assignment = workers?.['describe'];
    const provider = PROVIDERS.find((p) => p.id === assignment?.provider);
    if (provider) this.activeProvider.set(provider.id);
    this.selectedModel.set(assignment?.model ?? this.activeMeta().defaultModel);
  }

  loadConfig(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.aiApi
      .getConfig()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (cfg: AiConfigResponse) => {
          this.applyLoadedProviders(cfg.providers);
          this.applyLoadedWorkers(cfg);
          this.loading.set(false);
          this.fetchModels(this.activeProvider());
        },
        error: (err: HttpErrorResponse) => {
          this.loadError.set(err.error?.message ?? 'Failed to load AI configuration.');
          this.loading.set(false);
        },
      });
  }

  selectProvider(id: AiProviderId): void {
    this.activeProvider.set(id);
    this.connectionRequest++;
    this.testLoading.set(false);
    this.testResult.set(null);
    this.modelsError.set(null);
    const existing = this.modelsByProvider()[id];
    if (existing && existing.length > 0) {
      this.selectedModel.set(existing[0]!);
    } else {
      const meta = PROVIDERS.find((p) => p.id === id);
      this.selectedModel.set(meta?.defaultModel ?? '');
    }
    this.fetchModels(id);
  }

  fetchModels(provider: AiProviderId): void {
    this.modelsLoading.set(true);
    this.modelsError.set(null);

    const payload = {
      provider,
      url: provider === 'ollama' ? this.fOllamaUrl().trim() : null,
      ...(this.getApiKeyForProvider(provider)
        ? { api_key: this.getApiKeyForProvider(provider) }
        : {}),
    };

    const request = ++this.modelRequest;
    this.aiApi
      .listModels(payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (request !== this.modelRequest || provider !== this.activeProvider()) return;
          if (res.models && res.models.length > 0) {
            this.modelsByProvider.update((cur) => ({
              ...cur,
              [provider]: res.models,
            }));
            if (!res.models.includes(this.selectedModel())) {
              this.selectedModel.set(res.models[0]!);
            }
          }
          if (res.error) {
            this.modelsError.set(res.error);
          }
          this.modelsLoading.set(false);
        },
        error: (err: HttpErrorResponse) => {
          if (request !== this.modelRequest || provider !== this.activeProvider()) return;
          this.modelsError.set(err.error?.error ?? 'Failed to fetch models from provider.');
          this.modelsLoading.set(false);
        },
      });
  }

  testConnection(): void {
    const provider = this.activeProvider();
    this.testLoading.set(true);
    this.testResult.set(null);

    const payload = {
      provider,
      url: provider === 'ollama' ? this.fOllamaUrl().trim() : null,
      ...(this.getApiKeyForProvider(provider)
        ? { api_key: this.getApiKeyForProvider(provider) }
        : {}),
    };

    const request = ++this.connectionRequest;
    this.aiApi
      .testConnection(payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (request !== this.connectionRequest) return;
          this.testLoading.set(false);
          if (res.ok) {
            this.testResult.set({ ok: true, message: 'Connection successful!' });
          } else {
            this.testResult.set({ ok: false, message: res.error ?? 'Connection failed' });
          }
        },
        error: (err: HttpErrorResponse) => {
          if (request !== this.connectionRequest) return;
          this.testLoading.set(false);
          this.testResult.set({
            ok: false,
            message: err.error?.error ?? err.message ?? 'Connection failed',
          });
        },
      });
  }

  onModelChange(model: string): void {
    this.selectedModel.set(model);
  }

  isAssigned(workerId: string): boolean {
    const a = this.workerAssignments()[workerId];
    return a?.provider === this.activeProvider() && a?.model === this.selectedModel();
  }

  toggleWorkerAssignment(workerId: string, checked: boolean): void {
    if (checked) {
      this.assignActiveToWorker(workerId);
    }
  }

  assignActiveToWorker(workerId: string): void {
    const provider = this.activeProvider();
    const model = this.selectedModel();
    this.workerAssignments.update((cur) => ({
      ...cur,
      [workerId]: { provider, model },
    }));
  }

  save(): void {
    this.saveState.set({ kind: 'saving' });

    const patch: Parameters<AiApiService['updateConfig']>[0] = {
      providers: {
        ollama: {
          url: this.fOllamaUrl().trim() || null,
        },
      },
      workers: this.workerAssignments(),
    };

    const openAiKey = this.fOpenAiKey().trim();
    if (openAiKey) {
      patch.providers!.openai = { api_key: openAiKey };
    }
    const anthropicKey = this.fAnthropicKey().trim();
    if (anthropicKey) {
      patch.providers!.anthropic = { api_key: anthropicKey };
    }
    const geminiKey = this.fGeminiKey().trim();
    if (geminiKey) {
      patch.providers!.gemini = { api_key: geminiKey };
    }

    this.aiApi
      .updateConfig(patch)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saveState.set({ kind: 'saved' });
          if (openAiKey) this.hasOpenAiKey.set(true);
          if (anthropicKey) this.hasAnthropicKey.set(true);
          if (geminiKey) this.hasGeminiKey.set(true);
          this.fOpenAiKey.set('');
          this.fAnthropicKey.set('');
          this.fGeminiKey.set('');
          setTimeout(() => {
            this.saveState.update((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
          }, 2000);
        },
        error: (err: HttpErrorResponse) => {
          this.saveState.set({
            kind: 'error',
            message: err.error?.error ?? err.error?.message ?? 'Failed to save configuration.',
          });
        },
      });
  }

  getApiKeyForProvider(provider: AiProviderId): string {
    switch (provider) {
      case 'openai':
        return this.fOpenAiKey().trim();
      case 'anthropic':
        return this.fAnthropicKey().trim();
      case 'gemini':
        return this.fGeminiKey().trim();
      default:
        return '';
    }
  }

  isProviderConfigured(id: AiProviderId): boolean {
    switch (id) {
      case 'ollama':
        return Boolean(this.fOllamaUrl().trim());
      case 'openai':
        return this.hasOpenAiKey() || Boolean(this.fOpenAiKey().trim());
      case 'anthropic':
        return this.hasAnthropicKey() || Boolean(this.fAnthropicKey().trim());
      case 'gemini':
        return this.hasGeminiKey() || Boolean(this.fGeminiKey().trim());
    }
  }
}
