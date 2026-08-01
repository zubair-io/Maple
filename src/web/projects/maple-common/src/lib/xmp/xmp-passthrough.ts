import type { AdjustmentModel } from '../models/adjustment-model';
import type { PassthroughBucket } from './xmp.types';
import { ADJUSTMENT_FIELDS, LEGACY_READ_ALIASES, WB_PRESET_FIELD } from './xmp-fields';
import { DC_NAMESPACE } from './xmp-culling';
import { METADATA_ATTR_KEYS, METADATA_NAMESPACES, METADATA_NESTED_ELEMENTS } from './xmp-metadata';
import { parseToneCurveElement, toneCurveElementKey } from './xmp-tone-curves';
import { CRS_NAMESPACE, managedXmpName, RDF_NAMESPACE, XMP_NAMESPACE } from './xmp-dom-utils';

/** Attributes fully owned by Maple and therefore excluded from passthrough. */
const KNOWN_ATTRIBUTES = new Set<string>([
  ...ADJUSTMENT_FIELDS.map((field) => field.xmpKey),
  ...LEGACY_READ_ALIASES.map((field) => field.xmpKey),
  WB_PRESET_FIELD.xmpKey,
  'xmp:Rating',
  'Rating',
  'maple:Flag',
  'papp:Flag',
  'Flag',
  'xmp:Label',
  'Label',
  'maple:ColorLabel',
  'papp:ColorLabel',
  'ColorLabel',
  'papp:Look',
  'papp:Profile',
  'papp:HotPixelSuppression',
  'crs:LensProfileEnable',
  'papp:HighlightRecoveryMode',
  'papp:AutoExposure',
  'papp:WbMethod',
  'papp:ToneCurveMode',
  'crs:ConvertToGrayscale',
  'papp:WbScaleVersion',
  'crs:HasCrop',
  'crs:CropTop',
  'crs:CropLeft',
  'crs:CropBottom',
  'crs:CropRight',
  'crs:CropAngle',
  'crs:CropConstrainToWarp',
  'rdf:about',
  'crs:Version',
  'crs:ProcessVersion',
  'crs:HasSettings',
  ...METADATA_ATTR_KEYS,
]);

const CANONICAL_NAMESPACE_URIS: Readonly<Record<string, string>> = {
  rdf: RDF_NAMESPACE,
  xmp: XMP_NAMESPACE,
  crs: CRS_NAMESPACE,
  papp: 'http://ns.justmaple.app/photo/1.0/',
  ...METADATA_NAMESPACES,
};

const isManagedChild = (child: Element): boolean => {
  if (child.namespaceURI === DC_NAMESPACE && child.localName === 'subject') {
    return true;
  }
  return METADATA_NESTED_ELEMENTS.some(
    (element) => child.namespaceURI === element.ns && child.localName === element.local,
  );
};

const visibleNamespaceUris = (description: Element): Map<string, string> => {
  const namespaces = new Map<string, string>();
  const ancestors: Element[] = [];
  for (let element: Element | null = description; element; element = element.parentElement) {
    ancestors.unshift(element);
  }
  for (const element of ancestors) {
    for (const attr of Array.from(element.attributes)) {
      if (attr.name.startsWith('xmlns:')) {
        namespaces.set(attr.name.slice('xmlns:'.length), attr.value);
      }
    }
  }
  return namespaces;
};

/** Serialize a foreign subtree with every namespace it inherited made explicit. */
const usedPrefix = (attribute: Attr): string | null =>
  attribute.prefix && attribute.prefix !== 'xmlns' && attribute.namespaceURI
    ? attribute.prefix
    : null;

const elementPrefixes = (element: Element): string[] =>
  [
    element.namespaceURI ? (element.prefix ?? '') : null,
    ...Array.from(element.attributes, usedPrefix),
  ].filter((prefix): prefix is string => prefix !== null);

const inScopeNamespaces = (source: Element): ReadonlyMap<string, string> => {
  const prefixes = new Set([source, ...source.querySelectorAll('*')].flatMap(elementPrefixes));
  return new Map(
    Array.from(prefixes).flatMap((prefix) => {
      const uri = source.lookupNamespaceURI(prefix || null);
      return uri ? [[prefix, uri]] : [];
    }),
  );
};

const addExplicitNamespaces = (element: Element, namespaces: ReadonlyMap<string, string>): void => {
  for (const [prefix, uri] of namespaces) {
    if (prefix === 'xml') continue;
    const name = prefix ? `xmlns:${prefix}` : 'xmlns';
    if (!element.hasAttribute(name)) {
      element.setAttributeNS('http://www.w3.org/2000/xmlns/', name, uri);
    }
  }
};

const selfContainedXml = (source: Element): string => {
  const clone = source.cloneNode(true) as Element;
  addExplicitNamespaces(clone, inScopeNamespaces(source));
  return clone.outerHTML;
};

const isModeledAttribute = (attribute: Attr): boolean => {
  const name = managedXmpName(attribute);
  return name !== null && name !== 'rdf:about' && KNOWN_ATTRIBUTES.has(name);
};

const withoutModeledFields = (source: Element): Element => {
  const clone = source.cloneNode(true) as Element;
  for (const attribute of Array.from(source.attributes)) {
    if (!isModeledAttribute(attribute)) continue;
    if (attribute.namespaceURI)
      clone.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    else clone.removeAttribute(attribute.name);
  }
  const clonedChildren = Array.from(clone.children);
  Array.from(source.children).forEach((child, index) => {
    if (toneCurveElementKey(child) || isManagedChild(child)) clonedChildren[index]?.remove();
  });
  return clone;
};

const preservedRdfNode = (element: Element): string => {
  const isDescription =
    element.namespaceURI === RDF_NAMESPACE && element.localName === 'Description';
  return selfContainedXml(isDescription ? withoutModeledFields(element) : element);
};

const preservedStructure = (
  description: Element,
  document?: Document,
): Pick<PassthroughBucket, 'unknownRdfNodes' | 'unknownXmpmetaNodes'> => {
  if (!document) return {};
  const rdf = description.parentElement;
  if (!rdf) return {};
  const unknownRdfNodes = Array.from(rdf.children)
    .filter((child) => child !== description)
    .map(preservedRdfNode);
  const xmpmeta = rdf.parentElement;
  const unknownXmpmetaNodes = xmpmeta
    ? Array.from(xmpmeta.children)
        .filter((child) => child !== rdf)
        .map(selfContainedXml)
    : [];
  return { unknownRdfNodes, unknownXmpmetaNodes };
};

/**
 * Capture fields Maple does not model and hydrate Maple-owned point curves.
 * The parser intentionally delegates the whole child classification here so
 * managed nodes can never also leak into the passthrough bucket.
 */
export function collectXmpPassthrough(
  description: Element,
  model: Partial<AdjustmentModel>,
  document?: Document,
): PassthroughBucket {
  const visibleNamespaces = visibleNamespaceUris(description);
  const passthroughNamespaceUris = new Map<string, string>();
  const unknownAttributes = Array.from(description.attributes)
    .filter((attr) => {
      if (attr.name.startsWith('xmlns')) return false;
      const managedName = managedXmpName(attr);
      return managedName === null || !KNOWN_ATTRIBUTES.has(managedName);
    })
    .map((attr) => {
      const canonicalUri = attr.prefix ? CANONICAL_NAMESPACE_URIS[attr.prefix] : undefined;
      if (attr.prefix && attr.namespaceURI && canonicalUri && canonicalUri !== attr.namespaceURI) {
        const prefix = `passthrough_${attr.prefix}`;
        passthroughNamespaceUris.set(prefix, attr.namespaceURI);
        return { name: `${prefix}:${attr.localName}`, value: attr.value };
      }
      return { name: attr.name, value: attr.value };
    });
  const unknownNodes: string[] = [];
  const passthroughPrefixes = new Set<string>();

  for (const child of Array.from(description.children)) {
    const curveKey = toneCurveElementKey(child);
    if (curveKey) {
      model[curveKey] = parseToneCurveElement(child);
      continue;
    }
    if (isManagedChild(child)) continue;
    unknownNodes.push(selfContainedXml(child));
  }

  for (const attr of unknownAttributes) {
    const colon = attr.name.indexOf(':');
    if (colon > 0) passthroughPrefixes.add(attr.name.slice(0, colon));
  }

  const unknownNamespaces = Array.from(passthroughPrefixes)
    .map((prefix) => ({
      prefix,
      uri: passthroughNamespaceUris.get(prefix) ?? visibleNamespaces.get(prefix),
    }))
    .filter((namespace): namespace is { prefix: string; uri: string } => !!namespace.uri);
  return {
    unknownNamespaces,
    unknownAttributes,
    unknownNodes,
    ...preservedStructure(description, document),
  };
}
