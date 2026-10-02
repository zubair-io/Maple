/** XMP field discovery only. Rust remains the owner of removal-record validation. */
import { SaxesParser } from 'saxes';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const owned = (uri: string) =>
  uri === 'http://ns.justmaple.app/photo/1.0/' || uri === 'http://ns.justmaple.app/1.0/';

export function removalRecords(xml: string): string | null {
  // Preserve ordinary legacy relocation behavior when no removal property is
  // present. A recognized property, including malformed XML, fails closed.
  if (!xml.includes('InpaintRemovals')) return null;
  const values: string[] = [];
  const descriptions: boolean[] = [];
  let text: string | null = null;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (text !== null) throw new Error('InpaintRemovals must contain scalar JSON');
    const description = tag.uri === RDF && tag.local === 'Description';
    if (description) {
      for (const attribute of Object.values(tag.attributes))
        if (attribute.local === 'InpaintRemovals' && owned(attribute.uri))
          values.push(attribute.value);
    }
    if (descriptions.at(-1) && tag.local === 'InpaintRemovals' && owned(tag.uri)) text = '';
    descriptions.push(description);
  });
  parser.on('text', (value) => {
    if (text !== null) text += value;
  });
  parser.on('cdata', (value) => {
    if (text !== null) text += value;
  });
  parser.on('closetag', () => {
    if (text !== null) {
      values.push(text);
      text = null;
    }
    descriptions.pop();
  });
  parser.write(xml).close();
  if (values.length > 1) throw new Error('Conflicting InpaintRemovals fields');
  return values[0] ?? null;
}
