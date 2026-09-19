/**
 * Shape data for the benchmark generator: the camera, lens, place and vision
 * vocabularies, the stage list, and the two helpers that sample them.
 *
 * Separate from `generate.ts` so the generator reads as the insert loop it is.
 * Values are illustrative rather than exhaustive — what matters for the
 * benchmark is the CARDINALITY and the skew, which is what determines how big a
 * facet index gets and how many groups an aggregation produces.
 */

export const CAMERAS: Array<[string, string]> = [
  ['Apple', 'iPhone 15 Pro'],
  ['Apple', 'iPhone 13'],
  ['Apple', 'iPhone 12 mini'],
  ['Hasselblad', 'L3D-100c'],
  ['Hasselblad', 'X2D 100C'],
  ['SONY', 'ILCE-7RM5'],
  ['SONY', 'ILCE-7M4'],
  ['Canon', 'EOS R5'],
  ['Canon', 'EOS 5D Mark IV'],
  ['NIKON CORPORATION', 'NIKON Z 8'],
  ['FUJIFILM', 'X-T5'],
  ['DJI', 'FC3582'],
  ['Panasonic', 'DC-S5M2'],
  ['RICOH IMAGING COMPANY, LTD.', 'GR III'],
  ['LEICA CAMERA AG', 'LEICA Q3'],
];

export const LENSES = [
  'iPhone 15 Pro back triple camera 6.86mm f/1.78',
  'Hasselblad 24mm f/1.5',
  'FE 24-70mm F2.8 GM II',
  'RF24-105mm F4 L IS USM',
  'NIKKOR Z 50mm f/1.2 S',
  'XF16-55mmF2.8 R LM WR',
  'DJI FC3582 lens',
  'Summilux 28mm f/1.7 ASPH',
  'LUMIX S 20-60mm F3.5-5.6',
  null,
];

export const PLACES: Array<[string, string, string]> = [
  ['us', 'New York', 'Albany'],
  ['us', 'New York', 'New York City'],
  ['us', 'California', 'San Francisco'],
  ['us', 'California', 'Los Angeles'],
  ['us', 'Massachusetts', 'Boston'],
  ['us', 'Vermont', 'Burlington'],
  ['gb', 'England', 'London'],
  ['gb', 'Scotland', 'Edinburgh'],
  ['fr', 'Île-de-France', 'Paris'],
  ['it', 'Lazio', 'Rome'],
  ['jp', 'Tokyo', 'Shibuya'],
  ['ca', 'Ontario', 'Toronto'],
  ['de', 'Berlin', 'Berlin'],
  ['es', 'Catalonia', 'Barcelona'],
  ['nl', 'North Holland', 'Amsterdam'],
];

/** Nonsense single tokens sprinkled thinly, so a selective search has
 * something to find. Real search terms sit between these and the common bag. */
export const RARE_TOKENS = ['zephyrhold', 'quillmarsh', 'brambleveil', 'tidewrack', 'emberfall'];

export const SCENES = ['indoor', 'outdoor', 'aerial', 'macro', 'studio', 'mixed'];
export const ACTIVITIES = ['hiking', 'cooking', 'lacrosse', 'sailing', 'cycling', 'dining', null];
export const STAGE_NAMES = [
  'exif',
  'thumb',
  'preview',
  'face-detect',
  'face-embed',
  'describe',
  'geocode',
  'meili',
  'sidecar-metadata-index',
  'cf-thumb-sync',
  'transcribe',
  'video-describe',
];

/**
 * A Zipf-ish pick: index 0 is much more likely than the tail, which is how
 * camera and place distributions actually look in a personal library.
 */
export function skewedIndex(random: () => number, length: number): number {
  const r = random() ** 2.2;
  return Math.min(length - 1, Math.floor(r * length));
}

export function words(random: () => number, count: number): string {
  const bag = [
    'harbour',
    'evening',
    'kitchen',
    'mountain',
    'portrait',
    'festival',
    'children',
    'skyline',
    'lantern',
    'crosswalk',
    'espresso',
    'rehearsal',
    'lighthouse',
    'backpack',
    'courtyard',
  ];
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(bag[Math.floor(random() * bag.length)]);
  return out.join(' ');
}
