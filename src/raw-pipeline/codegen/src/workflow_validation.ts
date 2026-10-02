/** Wire validation only. raw-core remains the checkpoint-XMP validator (#4035/#2437). */
export function parseSidecarWorkflow(input: unknown): SidecarWorkflow {
  validateRecord(input, 'SidecarWorkflow');
  const workflow = input as SidecarWorkflow;
  if (workflow.schemaVersion !== WORKFLOW_VERSION) throw new Error('Unsupported workflow version');
  if (workflow.variantId !== PRIMARY_VARIANT_ID) validateIdentity(workflow.variantId);
  validateName(workflow.variantName);
  if (workflow.history.length > WORKFLOW_HISTORY_LIMIT)
    throw new Error('Workflow history is too long');
  validateDistinct(workflow.snapshots);
  validateDistinct(workflow.history);
  for (const snapshot of workflow.snapshots) validateName(snapshot.name);
  for (const entry of workflow.history) {
    validateName(entry.label);
    if (!(WORKFLOW_ACTIONS as readonly string[]).includes(entry.action))
      throw new Error('Unsupported workflow action');
  }
  if (new TextEncoder().encode(JSON.stringify(workflow)).length > WORKFLOW_MAX_BYTES)
    throw new Error('Workflow exceeds byte budget');
  return structuredClone(workflow);
}
function validateRecord(input: unknown, type: string): void {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Workflow record must be an object');
  const value = input as Record<string, unknown>;
  const fields = WORKFLOW_FIELDS[type];
  if (
    Object.keys(value).length !== Object.keys(fields).length ||
    Object.keys(value).some((key) => !Object.hasOwn(fields, key))
  )
    throw new Error('Workflow record has missing or unknown fields');
  for (const [key, kind] of Object.entries(fields)) validateField(value[key], key, kind);
}
function validateField(field: unknown, key: string, kind: string): void {
  if (kind === 'string') {
    if (typeof field !== 'string') throw new Error(`Invalid workflow ${key}`);
    return;
  }
  if (kind === 'u32' || kind === 'u64') {
    const max = kind === 'u32' ? 4294967295 : WORKFLOW_MAX_TIMESTAMP_MS;
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0 || field > max)
      throw new Error(`Invalid workflow ${key}`);
    return;
  }
  if (!Array.isArray(field)) throw new Error(`Invalid workflow ${key}`);
  for (const child of field) validateRecord(child, kind);
}
function validateIdentity(id: string): void {
  if (
    id.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  )
    throw new Error('Workflow identity must be a lowercase UUID');
}
function validateName(name: string): void {
  if (
    !name ||
    !name.replace(/[\t\n\v\f\r ]/g, '') ||
    [...name].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  )
    throw new Error('Workflow name must contain visible text without controls');
}
function validateDistinct(entries: readonly { readonly id: string }[]): void {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new Error('Duplicate workflow identity');
  for (const entry of entries) validateIdentity(entry.id);
}
