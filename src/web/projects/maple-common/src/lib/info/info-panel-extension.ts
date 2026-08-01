import { InjectionToken, Provider, Type } from '@angular/core';

/** Optional app-owned section appended to the shared Info panel. */
export const INFO_PANEL_EXTENSION = new InjectionToken<Type<unknown> | null>(
  'INFO_PANEL_EXTENSION',
  { providedIn: 'root', factory: () => null },
);

export function provideInfoPanelExtension(component: Type<unknown>): Provider {
  return { provide: INFO_PANEL_EXTENSION, useValue: component };
}
