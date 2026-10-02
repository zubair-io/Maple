// #4035: exercise both generated Web and API records, with strict wire parsing.
import { parseSidecarWorkflow as web } from '../../../src/web/projects/maple-common/src/lib/generated/workflow.generated';
import { parseSidecarWorkflow as api } from '../../../src/api/src/generated/workflow.generated';

const input = await Bun.stdin.text();
const records: unknown = JSON.parse(input);
if (!Array.isArray(records)) throw new Error('Expected workflow record set');
process.stdout.write(JSON.stringify(records.map((record) => api(web(record)))));
