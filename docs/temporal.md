# Temporal

Maple Self Hosted runs all of its background work on a [Temporal](https://temporal.io) server: the per-asset pipeline stages, the discover sweep, scheduled maintenance, user jobs, the operator's one-shots and folder imports. This page is the one place that describes how Maple uses it. The subsystems themselves are described in [Indexer, Workers and Search](indexer-enrichment.md).

## How it fits together

1. **The database is the record.** What every asset still needs (`stage_state`), which jobs and imports are queued (`jobs`, `imports`), where each sweep has got to (`discover_frontier`, `indexer_checkpoints`), and every pause switch, interval and setting live in SQLite. Every client reads them there.
2. **Temporal is the schedule.** It decides when a piece of that work runs and on which worker, notices when a worker dies, and delivers the work again. It holds no Maple data that the database does not also hold.
3. **Only the worker tier talks to Temporal.** The API process holds no Temporal client. A route writes a row or a setting; the worker tier (`workers/worker-main.ts`, the niced child the API spawns) reads it and starts, stops or reschedules the matching Temporal workflow. That is why a pause on Settings → Workers or a new job reaches Temporal within a second or ten, and why the API keeps serving while Temporal is down.

The worker tier runs one Temporal host (`temporal/temporal-host.ts`) with one Temporal worker per lane (`temporal/worker-tier-host.ts`), so no lane ever waits on another.

## Lanes

| Lane                                           | Task queue          | What runs                                                                                                                                                                                                         | Workflow id                                                                            | At once                          | How work reaches it                                                                                                      | What pausing means                                                                                       |
| ---------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Jobs (`job-runner/job-queue.ts`)               | `maple-jobs`        | User jobs: exports, batch edits, panorama stitches and previews, cloud-backup restores                                                                                                                            | `job-<job id>`                                                                         | 1, in creation order             | A route inserts a `queued` row; the relay hands the oldest one to Temporal once nothing else on the lane is running      | No pause; a job is cancelled through the API or in Temporal                                              |
| Operations (`job-runner/operation-queue.ts`)   | `maple-operations`  | The operator's one-shots: mirror reconcile, face clustering, folder scans                                                                                                                                         | `job-<job id>`                                                                         | 4 (one per kind, one per folder) | Same relay as jobs, over operation rows only                                                                             | As jobs                                                                                                  |
| Imports (`imports/import-queue.ts`)            | `maple-imports`     | Folder imports                                                                                                                                                                                                    | `import-<import id>`                                                                   | 1, in creation order             | Same relay, over `pending` import rows                                                                                   | As jobs                                                                                                  |
| Stages (`workers/stage-lane.ts`)               | `maple-stages`      | The pipeline stages (EXIF, thumbnails, previews, describe, geocode, faces, search, …), in slices of about ten seconds                                                                                             | `stage-<stage name>`                                                                   | One slice per stage              | About once a second the lane asks each unpaused stage whether a claim would find anything, and starts its workflow if so | The stage's switch on Settings → Workers; the running slice ends before its next batch, within about 2 s |
| Discover (`workers/discover/discover-lane.ts`) | `maple-discover`    | The reconciliation sweep of each library root, in slices of about ten minutes                                                                                                                                     | `discover-<library id>`                                                                | 64 roots                         | Every ten seconds the lane starts a workflow for any registered root without one                                         | The `discover` switch; a paused slice visits nothing and heartbeats                                      |
| Maintenance (`workers/maintenance/lane.ts`)    | `maple-maintenance` | Trash purge and cleanup, change-log GC, the missing-file reaper, deduplicate, migrations, mirror scan and copy, derivative audit, generated search, cloud-backup upkeep, auth expiry, the nightly database backup | A Temporal Schedule `maintenance-<task>`; a forced run is `maintenance-<task>-run-now` | One pass per task                | Every ten seconds the lane makes each schedule match the task's interval and pause state, and starts any run-now request | The schedule is paused exactly when a pass would do nothing                                              |

The rules each lane follows — ordering, cancelling, redelivery, slicing, catch-up — are in the subsystem's own section: [Jobs](indexer-enrichment.md#jobs), [Operations](indexer-enrichment.md#operations), [Imports](indexer-enrichment.md#imports), [Scheduling: stages on Temporal](indexer-enrichment.md#scheduling-stages-on-temporal), [The sweep on Temporal](indexer-enrichment.md#the-sweep-on-temporal) and [Maintenance workers](indexer-enrichment.md#maintenance-workers).

Jobs, operations and imports share one relay (`temporal/row-queue.ts`). A row Temporal has been handed is marked `locked_by = 'temporal'` until an activity attempt claims it and writes its own id there; every later write to the row is fenced on that id, so an attempt that has been replaced writes nothing. Every ten seconds the relay checks each row it handed over: a workflow cancelled or terminated in Temporal cancels the row, and a workflow that is missing or closed without settling the row (an emptied or different Temporal server) is submitted again.

## What the Temporal UI shows

Temporal's web UI lists every workflow by the ids above, so a job, import or library is found by searching for its id.

- **A job or import** is one workflow with one activity. It completes when the row finishes and fails with the handler's message when the row fails. Cancelling or terminating it cancels the job or import.
- **A stage** shows a `stage-<name>` workflow only while it has work; it completes 10 to 20 seconds after the last asset. Each slice is one activity, so a backlog of a million assets is a few hundred activities an hour, not a million. Long runs continue as new after 500 slices.
- **A library** has a `discover-<library id>` workflow for as long as it is registered, one activity per ten-minute slice, continuing as new every hundred slices.
- **Maintenance** appears under Schedules. Editing, pausing or deleting a `maintenance-` schedule in the UI is undone within ten seconds: the settings in the database win.
- **Cancelling a stage or discover workflow** does not stop the work. The lane starts it again, because the database still says there is work. To stop a stage or the sweep, pause it on Settings → Workers.

Settings → Workers shows the connection itself: the address and namespace, and whether the worker tier last found the server connected or unreachable. A report older than 45 seconds is shown as unknown, because it means the worker tier is not running.

## When Temporal is unreachable

The API keeps serving the library: browsing, editing, search and sign-in do not touch Temporal. Background work stops where it is and nothing is lost:

- New and changed files are not discovered and stages do not advance; their rows wait in `stage_state` and `discover_frontier`.
- Jobs, operations and imports stay queued. A job or import already running keeps running to the end and records its result.
- Maintenance does not run. When the server answers again, each task makes up at most one missed pass.
- Routes that wait for the worker tier answer with a timeout instead of a result: clustering, scans and rescans after 90 seconds, a "Back up now" request reported as not picked up after two minutes.

The worker tier retries the connection every five seconds and picks everything up once the server answers. Settings → Workers shows the error meanwhile.

`MAPLE_INDEXER_AUTOSTART=0` starts the API without the worker tier, for an API-only replica. That server does no background work at all, the same list as above, so some server in the deployment must run the worker tier with Temporal reachable.

## After a crash or a deploy

A worker tier that dies is respawned by the API (1 s, doubling to 30 s if it keeps dying quickly). On a planned stop the worker tier stops every stage first (each waiting at most 30 seconds for its batch), then lets running activities finish; systemd's `TimeoutStopSec=30s` in `maple.service` bounds how long that can take. Whatever was still running when the process went away is delivered again once Temporal notices its heartbeat has stopped:

| Work               | Back after                                                                                           | Resumes from                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A stage slice      | About 1 minute (heartbeat timeout)                                                                   | The next claim; assets from the batch it had in hand wait out their 15-minute claim first |
| A discover slice   | About 1 minute; a directory left half visited waits for its five-minute frontier lease               | The saved frontier and checkpoint                                                         |
| A job or import    | About 5 minutes (heartbeat timeout)                                                                  | The checkpoint the handler saved; a reconcile starts over                                 |
| A maintenance pass | Its next scheduled run (the killed run fails after 5 minutes without a heartbeat; there is no retry) | Where the pass stopped                                                                    |

Queued work and schedules lose nothing: they live in the database and in Temporal, not in the process.

## One namespace per Maple server

Workflow ids and schedule names carry no server identity: every Maple server has a `stage-thumb` workflow and a `maintenance-trash-gc` schedule. Two Maple servers on the same Temporal namespace would therefore take each other's work, running slices and passes against the wrong database and rewriting each other's schedules. Jobs and imports catch it: an activity whose row is not in its server's database fails its workflow with "…is not in this server's database. Each Maple server needs its own Temporal namespace." (`temporal/activity-attempt.ts`). Stages, the sweep and maintenance cannot tell. Give each Maple server its own namespace (or its own Temporal server).

## Configuration

The address and namespace are the `temporal` settings document, edited by the owner under Settings → Workers (`GET`/`PUT /api/workers/temporal`, `workers/routes-temporal.ts`; resolution in `temporal/temporal-config.ts`). The address is taken from, in order:

1. the address saved under Settings → Workers;
2. `MAPLE_TEMPORAL_ADDRESS`, which exists only so a deployment that ships Temporal as a sibling service (`src/api/docker-compose.yml`) works before anyone opens Settings;
3. `127.0.0.1:7233`.

The namespace is the saved one, or `default`. A saved change takes effect without a restart: within ten seconds the worker tier stops taking new work, lets running work finish (Settings → Workers says it is waiting), and reconnects to the new server.

## Running a Temporal server

- **Development.** Install the [Temporal CLI](https://docs.temporal.io/cli) and run `temporal server start-dev`. It listens on `127.0.0.1:7233`, Maple's default, with its web UI on <http://localhost:8233>. Its state is in memory unless you pass `--db-filename`. The API test suite starts its own throwaway server the same way (`temporal/local-temporal.test-helpers.ts`); see [testing](testing.md).
- **Docker Compose.** `src/api/docker-compose.yml` starts a `temporal` service beside Maple: the same single-binary server (`temporalio/temporal`, `server start-dev`) with its state in one SQLite file on the `temporal_data` volume, which suits one Maple server. Its UI port 8233 is not published; publish it if you want the UI, and keep it on the LAN, because it has no sign-in.
- **A Temporal server you already run.** Delete the compose service, or set `MAPLE_TEMPORAL_ADDRESS` in `maple.service` or `docker run`, or save the address and a namespace of Maple's own under Settings → Workers. Maple needs no search attributes or other Temporal-side setup; the namespace only has to exist.
