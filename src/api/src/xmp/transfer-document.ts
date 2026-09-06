/** Namespace-aware spans let a batch change its selected fields without reserializing
 * unknown Lightroom/Maple data. Only the selected attribute tokens and curve nodes move. */
import { SaxesParser, type SaxesTagNS } from 'saxes';

export const TRANSFER_NAMESPACES: Readonly<Record<string, string>> = {
  crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
  papp: 'http://ns.justmaple.app/photo/1.0/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
};

export interface XmlSpan {
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  tag: SaxesTagNS;
  namespaces: Readonly<Record<string, string>>;
  children: XmlSpan[];
}

export function canonicalXmpName(uri: string, local: string): string | undefined {
  const prefix =
    uri === 'http://ns.justmaple.app/1.0/'
      ? 'papp'
      : Object.keys(TRANSFER_NAMESPACES).find((key) => TRANSFER_NAMESPACES[key] === uri);
  return prefix ? `${prefix}:${local}` : undefined;
}

export function xmlSpans(xml: string): XmlSpan[] {
  const parser = new SaxesParser({ xmlns: true });
  const roots: XmlSpan[] = [];
  const stack: XmlSpan[] = [];
  let start = 0;
  parser.on('doctype', () => {
    throw new Error('DOCTYPE is not supported in an XMP sidecar');
  });
  parser.on('opentagstart', () => {
    start = xml.lastIndexOf('<', parser.position - 1);
  });
  parser.on('opentag', (tag) => {
    const parent = stack.at(-1);
    const span: XmlSpan = {
      start,
      openEnd: parser.position,
      closeStart: parser.position,
      end: parser.position,
      tag,
      children: [],
      namespaces: { ...parent?.namespaces, ...tag.ns },
    };
    (parent ? parent.children : roots).push(span);
    stack.push(span);
  });
  parser.on('closetag', (tag) => {
    const span = stack.pop();
    if (!span) throw new Error('Unbalanced XMP');
    span.end = parser.position;
    span.closeStart = tag.isSelfClosing ? span.openEnd : xml.lastIndexOf('</', parser.position - 1);
  });
  parser.write(xml).close();
  return roots;
}

export function descriptions(roots: readonly XmlSpan[]): XmlSpan[] {
  return roots.flatMap((node) =>
    canonicalXmpName(node.tag.uri, node.tag.local) === 'rdf:RDF'
      ? node.children.filter(
          (child) => canonicalXmpName(child.tag.uri, child.tag.local) === 'rdf:Description',
        )
      : descriptions(node.children),
  );
}

const escape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\t', '&#9;');

/** Remove selected tokens only, then append values using prefixes which cannot
 * reinterpret the namespaces of any untouched attribute or descendant. */
export function patchedOpeningTag(
  xml: string,
  span: XmlSpan,
  attributes: Readonly<Record<string, string | null>>,
  append: boolean,
): string {
  const original = xml.slice(span.start, span.openEnd);
  const stripped = original.replace(
    /\s+([^\s=<>]+)\s*=\s*(?:"[^"]*"|'[^']*')/g,
    (token, name: string) => {
      const attr = span.tag.attributes[name];
      const key = attr ? canonicalXmpName(attr.uri, attr.local) : undefined;
      return key && Object.hasOwn(attributes, key) ? '' : token;
    },
  );
  if (!append) return stripped;
  const namespaces = { ...span.namespaces };
  const added: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null) continue;
    const [canonicalPrefix, local] = key.split(':');
    const uri = TRANSFER_NAMESPACES[canonicalPrefix];
    let prefix = canonicalPrefix;
    while (namespaces[prefix] && namespaces[prefix] !== uri) prefix = `maple_${prefix}`;
    if (namespaces[prefix] !== uri) {
      added.push(`xmlns:${prefix}="${uri}"`);
      namespaces[prefix] = uri;
    }
    added.push(`${prefix}:${local}="${escape(value)}"`);
  }
  if (added.length === 0) return stripped;
  return stripped.replace(
    /\s*(\/?>)$/,
    (_ending, close: string) =>
      `${added.length ? `\n      ${added.join('\n      ')}` : ''}${close}`,
  );
}

export const EMPTY_TRANSFER_XMP =
  '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
  `  <rdf:RDF xmlns:rdf="${TRANSFER_NAMESPACES['rdf']}">\n` +
  `    <rdf:Description rdf:about="" xmlns:crs="${TRANSFER_NAMESPACES['crs']}" crs:Version="11.0" crs:ProcessVersion="11.0" crs:HasSettings="True"/>\n` +
  '  </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>';
