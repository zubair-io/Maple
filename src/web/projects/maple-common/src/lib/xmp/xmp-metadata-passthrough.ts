import { canonicalDocument } from './xmp-canonical';
import { hasXmlParseError, managedXmpName, RDF_NAMESPACE, rdfDescriptions } from './xmp-dom-utils';
import { METADATA_ATTR_KEYS, METADATA_NESTED_ELEMENTS } from './xmp-metadata';
import { passthroughAttrParts } from './xmp-serializer-parts';
import type { PassthroughBucket, XmpMetadata } from './xmp.types';

const metadataAttributes = new Set(METADATA_ATTR_KEYS);
const isMetadataAttribute = (attribute: Attr): boolean =>
  metadataAttributes.has(managedXmpName(attribute) ?? '');
const isMetadataElement = (element: Element): boolean =>
  METADATA_NESTED_ELEMENTS.some(
    (field) => field.ns === element.namespaceURI && field.local === element.localName,
  );

function parsePreservedXml(xml: string): Document {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (hasXmlParseError(document))
    throw new Error('Cannot replace metadata in malformed preserved XMP.');
  return document;
}

function remainingAttributes(
  passthrough: PassthroughBucket,
): PassthroughBucket['unknownAttributes'] {
  // Resolve the actual source namespace bindings, including aliases and foreign
  // namespaces reusing a familiar prefix. Qualified-name string matching loses data.
  const document = parsePreservedXml(
    canonicalDocument(
      (passthrough.unknownNamespaces ?? []).map(({ prefix, uri }) => [prefix, uri]),
      passthroughAttrParts(passthrough),
      '',
    ),
  );
  const description = rdfDescriptions(document)[0];
  const replaced = new Set(
    Array.from(description.attributes)
      .filter(isMetadataAttribute)
      .map((attribute) => attribute.name),
  );
  return passthrough.unknownAttributes.filter(({ name }) => !replaced.has(name));
}

function remainingChild(xml: string): string[] {
  return isMetadataElement(parsePreservedXml(xml).documentElement) ? [] : [xml];
}

function remainingDescription(xml: string): string {
  const element = parsePreservedXml(xml).documentElement;
  if (element.namespaceURI !== RDF_NAMESPACE || element.localName !== 'Description') return xml;
  let changed = false;
  for (const attribute of Array.from(element.attributes).filter(isMetadataAttribute)) {
    element.removeAttributeNode(attribute);
    changed = true;
  }
  for (const child of Array.from(element.children).filter(isMetadataElement)) {
    child.remove();
    changed = true;
  }
  return changed ? element.outerHTML : xml;
}

/**
 * Ordinary three-argument writes keep the original metadata XML. Explicit
 * metadata writes (including an empty object to clear fields) replace only
 * modeled metadata, without duplicating it in any RDF description.
 */
export function passthroughForMetadataReplacement(
  passthrough: PassthroughBucket | undefined,
  metadata: XmpMetadata | undefined,
): PassthroughBucket | undefined {
  if (!passthrough || metadata === undefined) return passthrough;
  return {
    ...passthrough,
    unknownAttributes: remainingAttributes(passthrough),
    unknownNodes: passthrough.unknownNodes.flatMap(remainingChild),
    unknownRdfNodes: passthrough.unknownRdfNodes?.map(remainingDescription),
  };
}
