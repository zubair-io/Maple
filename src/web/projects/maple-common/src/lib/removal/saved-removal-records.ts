// Sidecar record discovery by namespace identity; Rust owns record validation.
import { hasXmlParseError, managedXmpName, rdfDescriptions } from '../xmp/xmp-dom-utils';

export function savedRemovalRecords(xml: string): string | undefined {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (hasXmlParseError(document)) throw new Error('Cannot render a malformed photo sidecar.');
  const values = rdfDescriptions(document).flatMap((description) =>
    [...description.attributes, ...description.children]
      .filter((node) => managedXmpName(node) === 'papp:InpaintRemovals')
      .map((node) => (node instanceof Attr ? node.value : (node.textContent ?? ''))),
  );
  if (values.length > 1) throw new Error('The sidecar contains conflicting removal records.');
  const records = values[0];
  if (records === undefined) return undefined;
  const parsed: unknown = JSON.parse(records);
  if (!Array.isArray(parsed)) throw new Error('Invalid saved removal record list.');
  return parsed.length === 0 ? undefined : records;
}
