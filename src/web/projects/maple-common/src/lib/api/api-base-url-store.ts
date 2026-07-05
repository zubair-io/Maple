// ApiBaseUrlStore — the mutable backing value for API_BASE_URL.
//
// Defaults to relative '/api' (same-origin, reverse-proxied deployment).
// `network-preference-bootstrap.ts`'s blocking app initializer calls
// `setLocal()` before the component tree (and thus BunApiBackendService,
// which injects API_BASE_URL in its constructor) is created, so every
// consumer sees the final value on first injection — see that file for the
// full rationale.

import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ApiBaseUrlStore {
  private _value = '/api';

  get value(): string {
    return this._value;
  }

  setLocal(base: string): void {
    this._value = base;
  }
}
