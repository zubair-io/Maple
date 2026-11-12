/**
 * The maintenance lane: Temporal Schedules kept in step with the task list,
 * and run-now requests handed over as runs.
 *
 * The database is the desired state. Every reconcile makes each task's
 * schedule match what its settings ask for — creating it, changing its
 * interval, pausing or resuming it — and removes maintenance schedules for
 * tasks that no longer exist, so an edit or a deletion made in the Temporal UI
 * is put back within one reconcile. A Temporal outage delays runs; at most one
 * missed run per task is made up when it ends.
 */

import {
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  type Client,
  type ScheduleDescription,
  type ScheduleHandle,
} from '@temporalio/client';
import { child as childLogger } from '../../log.ts';
import type { TemporalLane } from '../../temporal/temporal-lane.ts';
import { maintenanceWorkflow } from '../../temporal/workflows.ts';
import { createMaintenanceActivities } from './activity.ts';
import { maintenanceRunNowId, maintenanceScheduleId, SCHEDULE_PREFIX } from './ids.ts';
import { clearMaintenanceRun, pendingMaintenanceRuns } from './run-now.repo.ts';
import { MAINTENANCE_TASKS, type DesiredSchedule, type MaintenanceTask } from './tasks.ts';
import { MAINTENANCE_TASK_QUEUE } from './workflow.ts';

const log = childLogger('maintenance');

const MIN_CATCHUP_WINDOW_MS = 60_000;

/**
 * One interval: a run missed while Temporal was down is made up once it is
 * back, so a daily task whose run fell inside an outage does not wait a whole
 * day, and no more than one missed run is ever replayed.
 */
const catchupWindowMs = (desired: DesiredSchedule): number =>
  Math.max(desired.everyMs, MIN_CATCHUP_WINDOW_MS);

export { maintenanceRunNowId, maintenanceScheduleId } from './ids.ts';

/** Everything about a schedule this lane owns, apart from whether it is paused. */
const scheduleBody = (taskId: string, desired: DesiredSchedule) => ({
  spec: { intervals: [{ every: desired.everyMs }] },
  action: {
    type: 'startWorkflow' as const,
    workflowType: maintenanceWorkflow,
    workflowId: maintenanceScheduleId(taskId),
    taskQueue: MAINTENANCE_TASK_QUEUE,
    args: [taskId] as [string],
  },
  policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: catchupWindowMs(desired) },
});

function intervalMatches(current: ScheduleDescription, desired: DesiredSchedule): boolean {
  const { intervals = [], calendars = [] } = current.spec;
  const [interval] = intervals;
  return (
    intervals.length === 1 &&
    calendars.length === 0 &&
    interval.every === desired.everyMs &&
    !interval.offset
  );
}

function actionMatches(current: ScheduleDescription, taskId: string): boolean {
  const { action } = current;
  return (
    action.workflowType === maintenanceWorkflow.name &&
    action.taskQueue === MAINTENANCE_TASK_QUEUE &&
    action.workflowId === maintenanceScheduleId(taskId) &&
    JSON.stringify(action.args) === JSON.stringify([taskId])
  );
}

function policiesMatch(current: ScheduleDescription, desired: DesiredSchedule): boolean {
  return (
    current.policies.overlap === ScheduleOverlapPolicy.SKIP &&
    current.policies.catchupWindow === catchupWindowMs(desired)
  );
}

function scheduleMatches(
  current: ScheduleDescription,
  taskId: string,
  desired: DesiredSchedule,
): boolean {
  return (
    current.state.paused === desired.paused &&
    intervalMatches(current, desired) &&
    actionMatches(current, taskId) &&
    policiesMatch(current, desired)
  );
}

async function describeOrNull(handle: ScheduleHandle): Promise<ScheduleDescription | null> {
  try {
    return await handle.describe();
  } catch (error) {
    if (error instanceof ScheduleNotFoundError) return null;
    throw error;
  }
}

/**
 * A schedule that starts running — new, or resumed — runs its first pass at
 * once rather than one interval later, the way the in-process timers it
 * replaced ran at boot and on resume.
 */
async function reconcileTask(client: Client, task: MaintenanceTask): Promise<void> {
  const desired = await task.desired();
  const scheduleId = maintenanceScheduleId(task.id);
  const handle = client.schedule.getHandle(scheduleId);
  const current = await describeOrNull(handle);
  if (current === null) {
    await client.schedule.create({
      scheduleId,
      ...scheduleBody(task.id, desired),
      state: { paused: desired.paused, triggerImmediately: !desired.paused },
    });
    return;
  }
  if (scheduleMatches(current, task.id, desired)) return;
  await handle.update(() => ({
    ...scheduleBody(task.id, desired),
    state: { paused: desired.paused },
  }));
  if (current.state.paused && !desired.paused) await handle.trigger(ScheduleOverlapPolicy.SKIP);
}

async function deleteRetiredSchedules(client: Client, wanted: ReadonlySet<string>): Promise<void> {
  for await (const schedule of client.schedule.list()) {
    const { scheduleId } = schedule;
    if (scheduleId.startsWith(SCHEDULE_PREFIX) && !wanted.has(scheduleId))
      await client.schedule.getHandle(scheduleId).delete();
  }
}

/** One task's unreadable settings must not hold back every other schedule. */
async function reconcileSchedules(
  client: Client,
  tasks: readonly MaintenanceTask[],
): Promise<void> {
  for (const task of tasks) {
    await reconcileTask(client, task).catch((error: unknown) => {
      log.warn(
        { task: task.id, err: error instanceof Error ? error.message : String(error) },
        'could not bring a maintenance schedule in line with its settings',
      );
    });
  }
  await deleteRetiredSchedules(
    client,
    new Set(tasks.map((task) => maintenanceScheduleId(task.id))),
  );
}

/**
 * Started directly rather than through the schedule, so a run-now carries its
 * options and runs while the schedule is paused. Starting before clearing
 * means a crash in between repeats the start, which the fixed workflow id
 * turns into the run already going.
 */
async function relayRunNow(client: Client): Promise<void> {
  for (const request of await pendingMaintenanceRuns()) {
    await client.workflow.start(maintenanceWorkflow, {
      workflowId: maintenanceRunNowId(request.taskId),
      taskQueue: MAINTENANCE_TASK_QUEUE,
      args: [request.taskId, request.options],
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
    await clearMaintenanceRun(request);
  }
}

/** Every task gets a slot: the timers this replaced never waited on one another. */
export const maintenanceLane = (
  tasks: readonly MaintenanceTask[] = MAINTENANCE_TASKS,
): TemporalLane => ({
  taskQueue: MAINTENANCE_TASK_QUEUE,
  activities: createMaintenanceActivities(tasks),
  concurrency: tasks.length,
  relay: relayRunNow,
  reconcile: (client) => reconcileSchedules(client, tasks),
});
