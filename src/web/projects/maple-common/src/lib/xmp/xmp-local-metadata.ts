// Imported mask metadata travels with its correction/component through edits
// and undo. Only modeled attributes are replaced; foreign XML stays opaque.
import type { LocalXmpMetadata } from '../models/local-adjustment';
import { managedXmpName } from './xmp-dom-utils';
import { selfContainedXml } from './xmp-foreign-xml';

const XMLNS = 'http://www.w3.org/2000/xmlns/';
const escapeAttribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function scopePrefixes(element: Element): Set<string> {
  const prefixes = new Set<string>();
  for (let scope: Element | null = element; scope; scope = scope.parentElement)
    for (const attribute of Array.from(scope.attributes)) {
      if (attribute.prefix) prefixes.add(attribute.prefix);
      if (attribute.namespaceURI === XMLNS) prefixes.add(attribute.localName);
    }
  return prefixes;
}

function metadataName(
  attribute: Attr,
  canonical: string | null,
  index: number,
  allocatePrefix: (seed: number) => string,
): string {
  const prefix = attribute.prefix;
  // Foreign bindings cannot redefine generated correction fields.
  const safeName =
    prefix && ['crs', 'rdf', 'papp'].includes(prefix) && !canonical
      ? `${allocatePrefix(index)}:${attribute.localName}`
      : attribute.name;
  return canonical ?? safeName;
}

export function localMetadata(
  element: Element,
  ownedAttributes: ReadonlySet<string>,
  ownedChildren: ReadonlySet<string> = new Set(),
): LocalXmpMetadata | undefined {
  const prefixes = scopePrefixes(element);
  const allocatePrefix = (seed: number): string => {
    let index = seed;
    while (prefixes.has(`maskmeta${index}`)) index++;
    const prefix = `maskmeta${index}`;
    prefixes.add(prefix);
    return prefix;
  };
  const attributes = Array.from(element.attributes).flatMap((attribute, index) => {
    const canonical = managedXmpName(attribute);
    if (attribute.namespaceURI === XMLNS || (canonical && ownedAttributes.has(canonical)))
      return [];
    return [
      {
        name: metadataName(attribute, canonical, index, allocatePrefix),
        value: attribute.value,
        ...(canonical || !attribute.namespaceURI ? {} : { namespace: attribute.namespaceURI }),
      },
    ];
  });
  const nodes = Array.from(element.childNodes).flatMap((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      return ownedChildren.has(managedXmpName(child) ?? '') ? [] : [selfContainedXml(child)];
    }
    return node.nodeType === Node.COMMENT_NODE ? [new XMLSerializer().serializeToString(node)] : [];
  });
  return attributes.length || nodes.length ? { attributes, nodes } : undefined;
}

export function localMetadataAttributes(
  metadata: LocalXmpMetadata | undefined,
  indent: string,
): string[] {
  if (!metadata) return [];
  const namespaces = new Map(
    metadata.attributes.flatMap((attribute) =>
      attribute.namespace && attribute.name.includes(':') && !attribute.name.startsWith('xml:')
        ? [[attribute.name.split(':')[0], attribute.namespace] as const]
        : [],
    ),
  );
  return [
    ...Array.from(
      namespaces,
      ([prefix, uri]) => `${indent}xmlns:${prefix}="${escapeAttribute(uri)}"`,
    ),
    ...metadata.attributes.map(
      (attribute) => `${indent}${attribute.name}="${escapeAttribute(attribute.value)}"`,
    ),
  ];
}

export const localMetadataNodes = (
  metadata: LocalXmpMetadata | undefined,
  indent: string,
): string[] => metadata?.nodes.map((xml) => indent + xml) ?? [];

const COMPONENT_ATTRIBUTES = new Set([
  'crs:What',
  'crs:MaskValue',
  'crs:MaskActive',
  'crs:MaskBlendMode',
  'crs:MaskInverted',
  'papp:MaskCombine',
  'papp:LocalFeather',
  'crs:ZeroX',
  'crs:ZeroY',
  'crs:FullX',
  'crs:FullY',
  'crs:Top',
  'crs:Left',
  'crs:Bottom',
  'crs:Right',
  'crs:Angle',
  'crs:Midpoint',
  'crs:Roundness',
  'crs:Feather',
  'crs:Flipped',
  'crs:Version',
  'crs:MaskSubType',
  'papp:MaskSource',
  'papp:MaskPerson',
  'papp:MaskFacialSkin',
  'papp:MaskBodySkin',
  'papp:MaskModel',
  'papp:MaskDigest',
]);

export const componentMetadata = (element: Element): LocalXmpMetadata | undefined =>
  localMetadata(element, COMPONENT_ATTRIBUTES);
