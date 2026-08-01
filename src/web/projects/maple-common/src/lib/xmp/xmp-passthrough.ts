import type { AdjustmentModel } from '../models/adjustment-model';
import type { PassthroughBucket } from './xmp.types';
import { ADJUSTMENT_FIELDS, LEGACY_READ_ALIASES, WB_PRESET_FIELD } from './xmp-fields';
import { DC_NAMESPACE } from './xmp-culling';
import { METADATA_ATTR_KEYS, METADATA_NESTED_ELEMENTS } from './xmp-metadata';
import { parseToneCurveElement, toneCurveElementKey } from './xmp-tone-curves';

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

const isManagedChild = (child: Element): boolean => {
  if (
    (child.namespaceURI === DC_NAMESPACE && child.localName === 'subject') ||
    child.tagName === 'dc:subject'
  ) {
    return true;
  }
  return METADATA_NESTED_ELEMENTS.some(
    (element) =>
      (child.namespaceURI === element.ns && child.localName === element.local) ||
      child.tagName === element.tag,
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

/**
 * Capture fields Maple does not model and hydrate Maple-owned point curves.
 * The parser intentionally delegates the whole child classification here so
 * managed nodes can never also leak into the passthrough bucket.
 */
export function collectXmpPassthrough(
  description: Element,
  model: Partial<AdjustmentModel>,
): PassthroughBucket {
  const visibleNamespaces = visibleNamespaceUris(description);
  const unknownAttributes = Array.from(description.attributes)
    .filter((attr) => !KNOWN_ATTRIBUTES.has(attr.name) && !attr.name.startsWith('xmlns'))
    .map((attr) => ({ name: attr.name, value: attr.value }));
  const unknownNodes: string[] = [];
  const passthroughPrefixes = new Set<string>();
  const rememberPrefix = (node: Element | Attr): void => {
    if (node.prefix && node.prefix !== 'xml' && node.prefix !== 'xmlns') {
      passthroughPrefixes.add(node.prefix);
    }
  };

  for (const child of Array.from(description.children)) {
    const curveKey = toneCurveElementKey(child);
    if (curveKey) {
      model[curveKey] = parseToneCurveElement(child);
      continue;
    }
    if (isManagedChild(child)) continue;
    for (const element of [child, ...Array.from(child.querySelectorAll('*'))]) {
      rememberPrefix(element);
      for (const attr of Array.from(element.attributes)) rememberPrefix(attr);
    }
    unknownNodes.push(child.outerHTML);
  }

  for (const attr of unknownAttributes) {
    const colon = attr.name.indexOf(':');
    if (colon > 0) passthroughPrefixes.add(attr.name.slice(0, colon));
  }

  const unknownNamespaces = Array.from(passthroughPrefixes)
    .map((prefix) => ({ prefix, uri: visibleNamespaces.get(prefix) }))
    .filter((namespace): namespace is { prefix: string; uri: string } => !!namespace.uri);
  return { unknownNamespaces, unknownAttributes, unknownNodes };
}
