// SignInComponent — shown at `/sign-in` in the Self-Hosted build.
//
// On mount, calls `auth.bootstrap()` to learn whether this server has been
// claimed yet. If not, the form claims it (creating the owner user + first
// passkey). If yes, the form signs an existing user in via WebAuthn.

import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../../maple-common/src/lib/auth/auth.service';

@Component({
  standalone: true,
  selector: 'maple-sign-in',
  imports: [FormsModule, RouterLink],
  templateUrl: './sign-in.component.html',
  styleUrl: './sign-in.component.scss',
})
export class SignInComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);

  email = '';
  claimed = signal<boolean | null>(null);
  busy = signal(false);
  error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      const r = await this.auth.bootstrap();
      this.claimed.set(r.claimed);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      if (this.claimed() === false) {
        await this.auth.claim(this.email, 'Web');
      } else {
        await this.auth.signIn(this.email);
      }
      await this.router.navigateByUrl('/');
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
