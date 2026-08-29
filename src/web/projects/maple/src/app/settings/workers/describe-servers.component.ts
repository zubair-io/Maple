// DescribeServersComponent — the Describe worker's server list on
// `/settings/workers`.
//
// The describe stage can be pointed at several Ollama endpoints, each with
// its own concurrency, and it fails over to the next one when a server is
// unreachable or erroring. Row order is meaningful: row 1 is the DEFAULT
// server, whose URL is what every other Ollama consumer (semantic search)
// uses — so "Make default" is a move-to-front, not a separate flag.
//
// The list is owned by the parent form (`WorkersComponent`'s enrichment
// form) and edited here through `servers` / `serversChange`; this component
// holds no persisted state of its own. The only side effect it owns is the
// per-row "Test connection" probe, which hits the same
// `/api/enrichment/test-describe` endpoint the single-URL field used.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { BunApiBackendService, MuiButtonComponent, MuiInputComponent } from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';
import {
  DEFAULT_DESCRIBE_SERVER_CONCURRENCY,
  FIXED_DESCRIBE_MODEL,
  MAX_DESCRIBE_SERVERS,
  MAX_DESCRIBE_SERVER_CONCURRENCY,
  describeCapacity,
  errorMessage,
  type DescribeServerForm,
} from './workers.vm';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

@Component({
  selector: 'maple-describe-servers',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MuiButtonComponent, MuiInputComponent, SettingsIconComponent],
  templateUrl: './describe-servers.component.html',
})
export class DescribeServersComponent {
  private readonly api = inject(BunApiBackendService);

  readonly servers = input.required<DescribeServerForm[]>();
  readonly serversChange = output<DescribeServerForm[]>();

  protected readonly maxServers = MAX_DESCRIBE_SERVERS;
  protected readonly maxConcurrency = MAX_DESCRIBE_SERVER_CONCURRENCY;
  protected readonly fixedDescribeModel = FIXED_DESCRIBE_MODEL;

  /** Keyed by row URL rather than index: a remove or a reorder must not
   * leave a stale "healthy" tick pointing at a different server. */
  private readonly testStates = signal<Record<string, TestState>>({});

  protected readonly capacity = computed(() => describeCapacity(this.servers()));

  protected testState(server: DescribeServerForm): TestState {
    return this.testStates()[server.url.trim()] ?? { kind: 'idle' };
  }

  protected setUrl(index: number, url: string): void {
    this.emit(this.servers().map((server, i) => (i === index ? { ...server, url } : server)));
  }

  protected setConcurrency(index: number, concurrency: string): void {
    this.emit(
      this.servers().map((server, i) => (i === index ? { ...server, concurrency } : server)),
    );
  }

  protected add(): void {
    if (this.servers().length >= MAX_DESCRIBE_SERVERS) return;
    this.emit([
      ...this.servers(),
      { url: '', concurrency: String(DEFAULT_DESCRIBE_SERVER_CONCURRENCY) },
    ]);
  }

  protected remove(index: number): void {
    const remaining = this.servers().filter((_, i) => i !== index);
    // Never leave the operator with nothing to type into: removing the last
    // row leaves one blank row, which saves as "no explicit list" and falls
    // back to the built-in localhost default.
    this.emit(
      remaining.length > 0
        ? remaining
        : [{ url: '', concurrency: String(DEFAULT_DESCRIBE_SERVER_CONCURRENCY) }],
    );
  }

  /** Promote a row to the front — that IS what "default" means here. */
  protected makeDefault(index: number): void {
    const servers = this.servers();
    const picked = servers[index];
    if (!picked || index === 0) return;
    this.emit([picked, ...servers.filter((_, i) => i !== index)]);
  }

  protected test(index: number): void {
    const url = this.servers()[index]?.url.trim() ?? '';
    if (url.length === 0) {
      this.setTestState(url, { kind: 'error', message: 'Enter a URL to test.' });
      return;
    }
    this.setTestState(url, { kind: 'testing' });
    this.api
      .testDescribeProvider({
        provider: 'ollama',
        url,
        model: FIXED_DESCRIBE_MODEL,
        api_key: null,
      })
      .subscribe({
        next: (res) =>
          this.setTestState(
            url,
            res.ok
              ? { kind: 'ok' }
              : { kind: 'error', message: res.error ?? 'Health check failed' },
          ),
        error: (err: unknown) =>
          this.setTestState(url, { kind: 'error', message: errorMessage(err) }),
      });
  }

  private setTestState(url: string, state: TestState): void {
    this.testStates.update((cur) => ({ ...cur, [url]: state }));
  }

  private emit(servers: DescribeServerForm[]): void {
    this.serversChange.emit(servers);
  }
}
