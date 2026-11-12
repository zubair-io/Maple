/**
 * Requests to run a maintenance task now, outside its schedule. The API
 * process holds no Temporal client, so a request is a row in the `maintenance`
 * settings document; the maintenance lane starts the run and then clears the
 * request.
 */

import {
  patchAppSettings,
  readAppSettings,
  unsetAppSettings,
} from '../../db/repos/app-settings.repo.ts';
import type { MaintenanceRunOptions } from './workflow.ts';

const DOC_ID = 'maintenance';

export interface MaintenanceRunRequest {
  taskId: string;
  requestedAt: string;
  options: MaintenanceRunOptions;
}

interface MaintenanceDoc {
  requests?: Record<string, { requestedAt: string; options?: MaintenanceRunOptions }>;
}

/** A repeat before the lane has picked it up replaces the waiting request. */
export async function requestMaintenanceRun(
  taskId: string,
  options: MaintenanceRunOptions = {},
): Promise<void> {
  await patchAppSettings(DOC_ID, {
    [`requests.${taskId}`]: { requestedAt: new Date().toISOString(), options },
  });
}

export async function pendingMaintenanceRuns(): Promise<MaintenanceRunRequest[]> {
  const doc = await readAppSettings<MaintenanceDoc>(DOC_ID);
  return Object.entries(doc?.requests ?? {}).map(([taskId, request]) => ({
    taskId,
    requestedAt: request.requestedAt,
    options: request.options ?? {},
  }));
}

/** Leaves a request made after `request` in place, so it gets a run of its own. */
export async function clearMaintenanceRun(request: MaintenanceRunRequest): Promise<void> {
  const pending = (await pendingMaintenanceRuns()).find((r) => r.taskId === request.taskId);
  if (pending?.requestedAt === request.requestedAt)
    await unsetAppSettings(DOC_ID, [`requests.${request.taskId}`]);
}

export async function maintenanceRunRequest(taskId: string): Promise<MaintenanceRunRequest | null> {
  return (await pendingMaintenanceRuns()).find((request) => request.taskId === taskId) ?? null;
}

// fallow-ignore-next-line unused-export -- the yes/no form the #5822 run-now routes read
export async function maintenanceRunRequested(taskId: string): Promise<boolean> {
  return (await maintenanceRunRequest(taskId)) !== null;
}
