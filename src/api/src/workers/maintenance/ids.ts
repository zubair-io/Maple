/** Every Temporal id the maintenance lane owns starts with this. */
export const SCHEDULE_PREFIX = 'maintenance-';

export const maintenanceScheduleId = (taskId: string): string => `${SCHEDULE_PREFIX}${taskId}`;

export const maintenanceRunNowId = (taskId: string): string =>
  `${SCHEDULE_PREFIX}${taskId}-run-now`;
