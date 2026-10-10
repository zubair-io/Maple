import { expect, vi } from 'vitest';
import type { HttpTestingController, TestRequest } from '@angular/common/http/testing';

export async function expectRequestAfterWebLock(
  ctrl: HttpTestingController,
  url: string,
): Promise<TestRequest> {
  let request: TestRequest | undefined;
  await vi.waitFor(() => {
    request = ctrl.match(url)[0];
    expect(request).toBeDefined();
  });
  return request!;
}
