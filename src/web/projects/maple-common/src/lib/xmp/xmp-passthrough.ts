import { selfContainedXml } from './xmp-foreign-xml';
import { collectMaskGroups, sharesMaskGroupContext } from './xmp-mask-group-passthrough';
import { orderLocalAdjustments, verbatimLayerOrders } from './xmp-verbatim-layer-order';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { PassthroughBucket } from './xmp.types';
import { ADJUSTMENT_FIELDS, LEGACY_READ_ALIASES, WB_PRESET_FIELD } from './xmp-fields';
import { DC_NAMESPACE } from './xmp-culling';
import { METADATA_NAMESPACES } from './xmp-metadata';
import { parseToneCurveElement, toneCurveElementKey } from './xmp-tone-curves';
import {
  localAdjustmentContainerKind,
  parseLocalAdjustmentsContainer,
} from './xmp-local-adjustments';
import {
  parseRetouchAreasContainer,
  parseRetouchInfoContainer,
  RETOUCH_FRAME_VERSION_KEY,
  retouchContainerKind,
} from './xmp-retouch';
import type { RetouchSpot } from '../models/retouch-spot';
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
  'papp:FilmLook',
  'papp:LensProfile',
  'papp:Demosaic',
  'papp:HotPixelSuppression',
  'crs:LensProfileEnable',
  'crs:AutoLateralCA',
  'papp:HighlightRecoveryMode',
  'papp:AutoExposure',
  'papp:WbMethod',
  'papp:WbSource',
  'papp:WbSampleX',
  'papp:WbSampleY',
  'papp:WbAlgorithmVersion',
  'papp:ToneCurveMode',
  'crs:ConvertToGrayscale',
  'papp:WbScaleVersion',
  RETOUCH_FRAME_VERSION_KEY,
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
]);

const CANONICAL_NAMESPACE_URIS: Readonly<Record<string, string>> = {
  rdf: RDF_NAMESPACE,
  xmp: XMP_NAMESPACE,
  crs: CRS_NAMESPACE,
  papp: 'http://ns.justmaple.app/photo/1.0/',
  ...METADATA_NAMESPACES,
};

// Ordinary adjustment saves do not replace metadata. Preserve its source XML,
// including language alternatives and multiple creators the metadata form cannot model.
/** A child element the serializer re-emits from the model, so it must never
 *  also survive as a passthrough node — that would emit it twice. Both
 *  repair containers (#3409) qualify: `crs:RetouchAreas` is rewritten from
 *  `model.retouchSpots`, and the legacy `crs:RetouchInfo` is read into the
 *  same list and replaced by the struct form on the next save. A legacy list
 *  that decodes to no spot is not the model's to replace, so it stays a
 *  passthrough node (#5658). */
const isManagedChild = (child: Element): boolean => {
  const retouchKind = retouchContainerKind(child);
  return (
    (child.namespaceURI === DC_NAMESPACE && child.localName === 'subject') ||
    retouchKind === 'areas' ||
    (retouchKind === 'legacy' && parseRetouchInfoContainer(child).length > 0)
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

const isModeledAttribute = (attribute: Attr): boolean => {
  const name = managedXmpName(attribute);
  return name !== null && name !== 'rdf:about' && KNOWN_ATTRIBUTES.has(name);
};

const eligibleDescriptions = (primary: Element): Element[] =>
  primary.parentElement
    ? Array.from(primary.parentElement.children).filter(
        (child) =>
          child.namespaceURI === RDF_NAMESPACE &&
          child.localName === 'Description' &&
          sharesMaskGroupContext(child, primary),
      )
    : [primary];

const withoutModeledFields = (source: Element, primary: Element): Element => {
  const clone = source.cloneNode(true) as Element;
  if (!sharesMaskGroupContext(source, primary)) return clone;
  for (const attribute of Array.from(source.attributes)) {
    if (!isModeledAttribute(attribute)) continue;
    if (attribute.namespaceURI)
      clone.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    else clone.removeAttribute(attribute.name);
  }
  const clonedChildren = Array.from(clone.children);
  Array.from(source.children).forEach((child, index) => {
    if (toneCurveElementKey(child) || localAdjustmentContainerKind(child) || isManagedChild(child))
      clonedChildren[index]?.remove();
  });
  return clone;
};

const preservedRdfNode = (element: Element, primary: Element): string => {
  const isDescription =
    element.namespaceURI === RDF_NAMESPACE && element.localName === 'Description';
  return selfContainedXml(isDescription ? withoutModeledFields(element, primary) : element);
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
    .map((element) => preservedRdfNode(element, description));
  const xmpmeta = rdf.parentElement;
  const unknownXmpmetaNodes = xmpmeta
    ? Array.from(xmpmeta.children)
        .filter((child) => child !== rdf)
        .map(selfContainedXml)
    : [];
  return { unknownRdfNodes, unknownXmpmetaNodes };
};

/**
 * Every repair spot `descriptions` carry (#3409). The struct
 * `crs:RetouchAreas` container wins whenever it produced one; the legacy
 * `crs:RetouchInfo` strings are the fallback for a document that only has
 * those.
 */
function retouchSpotsFrom(descriptions: readonly Element[]): RetouchSpot[] {
  const areas: RetouchSpot[] = [];
  const legacy: RetouchSpot[] = [];
  for (const description of descriptions) {
    for (const child of Array.from(description.children)) {
      const kind = retouchContainerKind(child);
      if (kind === 'areas') areas.push(...parseRetouchAreasContainer(child));
      else if (kind === 'legacy') legacy.push(...parseRetouchInfoContainer(child));
    }
  }
  return areas.length > 0 ? areas : legacy;
}

/** Layer-order keys of a brush container kept verbatim because it could not be modeled. */
const verbatimBrushLayerOrders = (descriptions: readonly Element[]): number[] =>
  descriptions.flatMap((description) =>
    Array.from(description.children)
      .filter(
        (child) =>
          !localAdjustmentContainerKind(child) &&
          !isManagedChild(child) &&
          managedXmpName(child) === 'papp:BrushCorrections',
      )
      .flatMap(verbatimLayerOrders),
  );

function isModeledDescriptionChild(
  child: Element,
  model: Partial<AdjustmentModel>,
  seenCurves: Set<string>,
): boolean {
  if (managedXmpName(child) === 'papp:InpaintRemovals') return true;
  const curveKey = toneCurveElementKey(child);
  if (curveKey) {
    if (!seenCurves.has(curveKey)) {
      seenCurves.add(curveKey);
      model[curveKey] = parseToneCurveElement(child);
    }
    return true;
  }
  const containerKind = localAdjustmentContainerKind(child);
  if (containerKind === 'group') return true;
  if (containerKind) {
    model.localAdjustments = [
      ...(model.localAdjustments ?? []),
      ...parseLocalAdjustmentsContainer(child, containerKind),
    ];
    return true;
  }
  return isManagedChild(child);
}

function hydrateDescriptionChildren(
  descriptions: readonly Element[],
  primary: Element,
  model: Partial<AdjustmentModel>,
): string[] {
  const unknownNodes: string[] = [];
  const seenCurves = new Set<string>();
  for (const current of descriptions) {
    for (const child of Array.from(current.children)) {
      if (isModeledDescriptionChild(child, model, seenCurves)) continue;
      if (current === primary) unknownNodes.push(selfContainedXml(child));
    }
  }
  return unknownNodes;
}

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
      // Removal records remain opaque metadata until the Rust boundary, but
      // the writer owns their replacement. Normalize recognized aliases so a
      // Keep cannot leave the old list beside a second canonical list (#3941).
      if (managedXmpName(attr) === 'papp:InpaintRemovals') {
        passthroughNamespaceUris.set('papp', CANONICAL_NAMESPACE_URIS['papp']);
        return { name: 'papp:InpaintRemovals', value: attr.value };
      }
      const canonicalUri = attr.prefix ? CANONICAL_NAMESPACE_URIS[attr.prefix] : undefined;
      if (attr.prefix && attr.namespaceURI && canonicalUri && canonicalUri !== attr.namespaceURI) {
        const prefix = `passthrough_${attr.prefix}`;
        passthroughNamespaceUris.set(prefix, attr.namespaceURI);
        return { name: `${prefix}:${attr.localName}`, value: attr.value };
      }
      return { name: attr.name, value: attr.value };
    });
  const passthroughPrefixes = new Set<string>();
  const descriptions = eligibleDescriptions(description);
  const retouchSpots = retouchSpotsFrom(descriptions);
  if (retouchSpots.length > 0) model.retouchSpots = retouchSpots;
  for (const current of descriptions)
    for (const child of Array.from(current.children))
      if (managedXmpName(child) === 'papp:InpaintRemovals') {
        passthroughNamespaceUris.set('papp', CANONICAL_NAMESPACE_URIS['papp']);
        unknownAttributes.push({ name: 'papp:InpaintRemovals', value: child.textContent ?? '' });
      }
  const unknownNodes = hydrateDescriptionChildren(descriptions, description, model);

  if (unknownAttributes.filter((a) => a.name === 'papp:InpaintRemovals').length > 1)
    throw new Error('The sidecar contains conflicting removal records.');
  const { verbatim: groupKeys, ...maskGroups } = collectMaskGroups(description, model);
  const verbatimLayerOrderKeys = [...verbatimBrushLayerOrders(descriptions), ...groupKeys];
  orderLocalAdjustments(model, verbatimLayerOrderKeys);

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
    ...maskGroups,
    ...(verbatimLayerOrderKeys.length ? { verbatimLayerOrders: verbatimLayerOrderKeys } : {}),
    ...preservedStructure(description, document),
  };
}
