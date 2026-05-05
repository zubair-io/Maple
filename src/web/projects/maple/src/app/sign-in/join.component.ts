// JoinComponent — shown at `/join` in the Self-Hosted build.
//
// Lets a user with an 8-character invite code register a passkey on the
// server that issued the invite. The invite-code input is uppercased on
// every keystroke since the codes are base32 (uppercase letters + digits).

import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../../maple-common/src/lib/auth/auth.service';

@Component({
  standalone: true,
  selector: 'maple-join',
  imports: [FormsModule, RouterLink],
  templateUrl: './join.component.html',
  styleUrl: './join.component.scss',
})
export class JoinComponent {
  private auth = inject(AuthService);
  private router = inject(Router);

  email = '';
  busy = signal(false);
  error = signal<string | null>(null);

  // Backing field + getter/setter pair so the [(ngModel)] write-back
  // normalises the invite code to uppercase as the user types.
  private _code = '';
  get code(): string {
    return this._code;
  }
  set code(value: string) {
    this._code = (value ?? '').toUpperCase();
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.join(window.location.origin, this.email, this.code, 'Web');
      await this.router.navigateByUrl('/');
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
