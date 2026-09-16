import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { AiApiService } from '@maple-common';
import { catchError, of } from 'rxjs';

@Component({
  selector: 'maple-ai-worker-summary',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './ai-worker-summary.component.html',
  styleUrl: './ai-worker-summary.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiWorkerSummaryComponent {
  readonly worker = input.required<string>();
  readonly config = toSignal(
    inject(AiApiService)
      .getConnections()
      .pipe(catchError(() => of(null))),
  );
  names(): string {
    const c = this.config();
    return (
      c?.assignments[this.worker()]?.connection_ids
        .map(
          (id) =>
            `${c.connections.find((v) => v.id === id)?.name ?? id} · ${c.assignments[this.worker()]?.connection_models?.[id] ?? c.assignments[this.worker()]?.model ?? ''}`,
        )
        .join(', ') ?? ''
    );
  }
}
