/**
 * Repair-spot frame (#4473, docs/xmp-canonical-format.md § Repair spots). An
 * unstamped repair list reads as upright when the document carries no Maple
 * attribute (Lightroom) and as the legacy sensor frame when it does, so a
 * partial write that introduces any `papp:` markup into a Lightroom sidecar
 * must stamp the retained list or every reader rotates it on reopen.
 */
import {
  canonicalXmpName,
  patchedOpeningTag,
  primaryDescription,
  xmlSpans,
  type XmlSpan,
} from './transfer-document.ts';

const FRAME_KEY = 'papp:RetouchFrameVersion';
// raw-core reads neither subtree's attributes as Maple authorship.
const OPAQUE_SUBTREES = new Set(['papp:Workflow', 'crs:Look']);

function visibleElements(spans: readonly XmlSpan[]): XmlSpan[] {
  return spans.flatMap((span) =>
    OPAQUE_SUBTREES.has(canonicalXmpName(span.tag.uri, span.tag.local) ?? '')
      ? []
      : [span, ...visibleElements(span.children)],
  );
}

const attributes = (span: XmlSpan) => Object.values(span.tag.attributes);

const carriesMapleMarkup = (elements: readonly XmlSpan[]): boolean =>
  elements.some(
    (span) =>
      canonicalXmpName(span.tag.uri, span.tag.local)?.startsWith('papp:') ||
      'papp' in span.tag.ns ||
      attributes(span).some((attr) => attr.prefix === 'papp'),
  );

const stamped = (elements: readonly XmlSpan[]): boolean =>
  elements.some((span) =>
    attributes(span).some(
      (attr) => canonicalXmpName(attr.uri, attr.local) === FRAME_KEY && attr.value === '2',
    ),
  );

const REPAIR_CONTAINERS = new Set(['crs:RetouchAreas', 'crs:RetouchInfo']);

// A superset of the lists raw-core decodes (structured areas and the legacy
// string `rdf:Seq`): stamping a list that was read as upright is always
// correct, while missing one flips it to the sensor frame.
const hasRepairSpots = (elements: readonly XmlSpan[]): boolean =>
  elements.some(
    (span) =>
      (REPAIR_CONTAINERS.has(canonicalXmpName(span.tag.uri, span.tag.local) ?? '') &&
        visibleElements(span.children).some(
          (child) => canonicalXmpName(child.tag.uri, child.tag.local) === 'rdf:li',
        )) ||
      attributes(span).some(
        (attr) =>
          canonicalXmpName(attr.uri, attr.local) === 'crs:RetouchInfo' && attr.value.trim() !== '',
      ),
  );

/** Stamps `after` when it keeps an upright repair list from `before` but now carries Maple markup. */
export function keepRetouchFrame(before: string, after: string): string {
  const prior = visibleElements(xmlSpans(before));
  const next = visibleElements(xmlSpans(after));
  const priorUpright = stamped(prior) || !carriesMapleMarkup(prior);
  if (!priorUpright || !hasRepairSpots(next) || stamped(next) || !carriesMapleMarkup(next))
    return after;
  const primary = primaryDescription(after);
  const opening = patchedOpeningTag(after, primary, { [FRAME_KEY]: '2' }, true);
  return after.slice(0, primary.start) + opening + after.slice(primary.openEnd);
}
