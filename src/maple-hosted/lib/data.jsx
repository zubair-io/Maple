// Mock data for the Coral Maple prototype.
// Placeholder images are generated SVG swatches (warm gradients) — we deliberately
// avoid drawing photo content; the user can drop in real imagery later.

const _paletteSwatches = [
  // Warm golds / sunsets
  ['#b97a3a', '#3a1d10'],
  ['#d28a4c', '#4a2210'],
  ['#e9a560', '#5c2a10'],
  // Deep forests
  ['#3e5a3a', '#17221a'],
  ['#5a7050', '#1e2a1a'],
  // Cool blues
  ['#3b5a7a', '#121d2a'],
  ['#4a6e90', '#172436'],
  ['#6a86a4', '#1f2c3e'],
  // Warm muted
  ['#8a5a4a', '#2a1510'],
  ['#a06e52', '#361c10'],
  // Rose / plum
  ['#9a5a6a', '#2e1520'],
  ['#b87080', '#381a28'],
  // Neutral / stone
  ['#6a6158', '#1f1c18'],
  ['#807468', '#26221c'],
  // High-contrast
  ['#c48040', '#20120a'],
  ['#d9b060', '#2e2410'],
];

function _swatchSvg(i, w, h) {
  const [a, b] = _paletteSwatches[i % _paletteSwatches.length];
  // Soft diagonal gradient with a vignette-ish darken at edges, and a hint of texture.
  const id = `g${i}`;
  const id2 = `v${i}`;
  return (
    `data:image/svg+xml;utf8,` + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}' preserveAspectRatio='xMidYMid slice'>
        <defs>
          <linearGradient id='${id}' x1='0' y1='0' x2='1' y2='1'>
            <stop offset='0' stop-color='${a}'/>
            <stop offset='1' stop-color='${b}'/>
          </linearGradient>
          <radialGradient id='${id2}' cx='0.5' cy='0.5' r='0.75'>
            <stop offset='0.6' stop-color='rgba(0,0,0,0)'/>
            <stop offset='1' stop-color='rgba(0,0,0,0.45)'/>
          </radialGradient>
        </defs>
        <rect width='${w}' height='${h}' fill='url(#${id})'/>
        <rect width='${w}' height='${h}' fill='url(#${id2})'/>
      </svg>`
    )
  );
}

// A varied set of images with realistic-ish metadata.
const MapleImages = [
  { file:'IMG_1042.CR3', w:6240, h:4160, iso:400,  ap:'f/2.8', ss:'1/250', mm:'50mm',  lens:'RF 50mm f/1.2', cam:'Canon EOS R5', flag:'pick', stars:4, edited:true,  date:'2026-03-18 14:22', title:'Place Vendôme, morning' },
  { file:'IMG_1043.CR3', w:6240, h:4160, iso:400,  ap:'f/2.8', ss:'1/250', mm:'50mm',  lens:'RF 50mm f/1.2', cam:'Canon EOS R5', flag:'none', stars:3, edited:false, date:'2026-03-18 14:23', title:'Arcades' },
  { file:'IMG_1044.CR3', w:6240, h:4160, iso:800,  ap:'f/4',   ss:'1/125', mm:'24mm',  lens:'RF 24-70 f/2.8',cam:'Canon EOS R5', flag:'pick', stars:5, edited:true,  date:'2026-03-18 15:01', title:'Tuileries light' },
  { file:'IMG_1045.CR3', w:6240, h:4160, iso:200,  ap:'f/5.6', ss:'1/500', mm:'85mm',  lens:'RF 85mm f/1.2', cam:'Canon EOS R5', flag:'none', stars:0, edited:false, date:'2026-03-18 15:12', title:'Louvre west wing' },
  { file:'IMG_1046.CR3', w:6240, h:4160, iso:200,  ap:'f/5.6', ss:'1/500', mm:'85mm',  lens:'RF 85mm f/1.2', cam:'Canon EOS R5', flag:'reject', stars:0, edited:false, date:'2026-03-18 15:13', title:'Missed focus' },
  { file:'IMG_1047.CR3', w:6240, h:4160, iso:1600, ap:'f/1.8', ss:'1/60',  mm:'35mm',  lens:'RF 35mm f/1.4', cam:'Canon EOS R5', flag:'pick', stars:5, edited:true,  date:'2026-03-18 19:44', title:'Rue de Rivoli dusk' },
  { file:'IMG_1048.CR3', w:6240, h:4160, iso:3200, ap:'f/1.8', ss:'1/125', mm:'35mm',  lens:'RF 35mm f/1.4', cam:'Canon EOS R5', flag:'none', stars:2, edited:false, date:'2026-03-18 20:02', title:'Café interior' },
  { file:'IMG_1049.CR3', w:6240, h:4160, iso:3200, ap:'f/1.8', ss:'1/125', mm:'35mm',  lens:'RF 35mm f/1.4', cam:'Canon EOS R5', flag:'none', stars:3, edited:true,  date:'2026-03-18 20:05', title:'Candle' },
  { file:'IMG_1050.CR3', w:6240, h:4160, iso:200,  ap:'f/8',   ss:'1/1000',mm:'16mm',  lens:'RF 16mm f/2.8', cam:'Canon EOS R5', flag:'pick', stars:4, edited:true,  date:'2026-03-19 09:15', title:'Pont Alexandre' },
  { file:'IMG_1051.CR3', w:6240, h:4160, iso:200,  ap:'f/8',   ss:'1/1000',mm:'16mm',  lens:'RF 16mm f/2.8', cam:'Canon EOS R5', flag:'none', stars:3, edited:false, date:'2026-03-19 09:17', title:'Pont Alexandre II' },
  { file:'IMG_1052.CR3', w:6240, h:4160, iso:400,  ap:'f/4',   ss:'1/250', mm:'70mm',  lens:'RF 24-70 f/2.8',cam:'Canon EOS R5', flag:'none', stars:0, edited:false, date:'2026-03-19 10:30', title:'Invalides dome' },
  { file:'IMG_1053.CR3', w:6240, h:4160, iso:400,  ap:'f/4',   ss:'1/250', mm:'70mm',  lens:'RF 24-70 f/2.8',cam:'Canon EOS R5', flag:'pick', stars:4, edited:true,  date:'2026-03-19 10:31', title:'Dome detail' },
  { file:'IMG_1054.CR3', w:6240, h:4160, iso:100,  ap:'f/11',  ss:'1/200', mm:'24mm',  lens:'RF 24-70 f/2.8',cam:'Canon EOS R5', flag:'pick', stars:5, edited:true,  date:'2026-03-19 12:48', title:'Seine bend' },
  { file:'IMG_1055.CR3', w:6240, h:4160, iso:100,  ap:'f/11',  ss:'1/200', mm:'24mm',  lens:'RF 24-70 f/2.8',cam:'Canon EOS R5', flag:'none', stars:2, edited:false, date:'2026-03-19 12:50', title:'Bridge wide' },
  { file:'IMG_1056.CR3', w:6240, h:4160, iso:800,  ap:'f/2.8', ss:'1/60',  mm:'50mm',  lens:'RF 50mm f/1.2', cam:'Canon EOS R5', flag:'none', stars:3, edited:true,  date:'2026-03-19 17:22', title:'Market stall' },
  { file:'IMG_1057.CR3', w:6240, h:4160, iso:1250, ap:'f/2',   ss:'1/100', mm:'50mm',  lens:'RF 50mm f/1.2', cam:'Canon EOS R5', flag:'none', stars:2, edited:false, date:'2026-03-19 17:40', title:'Bakery' },
].map((img, i) => {
  // Pre-compute a landscape/portrait aspect so the justified grid varies.
  const orientations = [3/2, 3/2, 2/3, 3/2, 3/2, 4/5, 3/2, 2/3, 3/2, 3/2, 4/5, 3/2, 3/2, 3/2, 2/3, 3/2];
  const ar = orientations[i % orientations.length];
  return {
    ...img,
    id: i + 1,
    ar,
    thumb: _swatchSvg(i, 600, Math.round(600/ar)),
    gps: { lat: 48.8566 + (i * 0.0037), lon: 2.3522 + (i * 0.0041) },
    city: 'Paris', region: 'Île-de-France', country: 'France',
    keywords: ['travel','paris','2026', i%2?'golden hour':'blue hour'],
  };
});

// File tree for the sidebar.
const MapleTree = [
  { kind: 'section', id: 'folders', label: 'Folders', count: null, children: [
    { kind: 'folder', id:'f-2026', label: '2026', open: true, children: [
      { kind: 'folder', id:'f-france', label: 'France trip', count: 128, selected: true },
      { kind: 'folder', id:'f-oslo',   label: 'Oslo weekend', count: 42 },
      { kind: 'folder', id:'f-studio', label: 'Studio work',  count: 376 },
    ]},
    { kind: 'folder', id:'f-2025', label: '2025', children: [
      { kind: 'folder', id:'f-summer', label: 'Summer', count: 890 },
      { kind: 'folder', id:'f-xmas',   label: 'Holidays', count: 214 },
    ]},
    { kind: 'folder', id:'f-scans', label: 'Film scans', count: 73 },
  ]},
  { kind: 'section', id: 'photos', label: 'Photos Library', count: null, children: [
    { kind: 'smart', id:'p-all',      label: 'All Photos',  icon: 'photos',  count: 14308 },
    { kind: 'smart', id:'p-fav',      label: 'Favorites',   icon: 'heart',   count: 482 },
    { kind: 'smart', id:'p-picks',    label: 'Picks',       icon: 'check',   count: 1204 },
    { kind: 'smart', id:'p-rejects',  label: 'Rejects',     icon: 'x',       count: 96 },
    { kind: 'subheader', label: 'Albums' },
    { kind: 'album', id:'a-portraits', label: 'Portraits 2026', count: 212 },
    { kind: 'album', id:'a-streets',   label: 'Street',         count: 641 },
    { kind: 'album', id:'a-recent',    label: 'Recents (smart)', count: 500, smart: true },
    { kind: 'album', id:'a-film',      label: 'Film look',       count: 87 },
  ]},
];

Object.assign(window, { MapleImages, MapleTree });
