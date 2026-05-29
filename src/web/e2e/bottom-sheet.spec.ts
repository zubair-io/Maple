// Bottom-sheet drag-to-dismiss e2e — deferred (#599 / S1c follow-up).
//
// This file is the parked Playwright contract for the pan-down dismiss
// behaviour spec'd in responsive-program-s1-phone-shell.md §4.2:
//   - drag distance ≥ 25% of sheet height → dismiss
//   - pointer velocity ≥ 1000 px/s at release → dismiss
//
// It's skipped today because S1c ships only the primitive — no consumer
// page mounts `<app-bottom-sheet>` until S4 Loupe / S5 Editor / S6 phone
// Detail land. The unit spec (bottom-sheet.component.spec.ts) covers DOM
// contract; drag logic is jsdom-hostile (no real PointerEvents) so it
// needs a real browser.
//
// When S4 or S5 mounts the primitive on a route, unskip and target that
// route. Suggested host: a Loupe route phone-mode opening Info from the
// toolbar.

import { test } from '@playwright/test';

test.describe('Bottom-sheet — drag-to-dismiss', () => {
  test.skip(true, 'Deferred to S4/S5/S6 — no consumer page mounts <app-bottom-sheet> yet.');

  test('dismisses on pan-down ≥ 25% sheet height', async () => {
    // TODO(S4/S5): navigate to a route that opens the Info bottom sheet,
    // grab the `.sheet` bounding box, drive a long pan-down via
    // `page.mouse.down/move/up`, assert the sheet is gone.
  });

  test('dismisses on flick (velocity ≥ 1000 px/s)', async () => {
    // TODO(S4/S5): same setup, drive a short fast pan-down (few samples,
    // short duration), assert dismissal.
  });
});
