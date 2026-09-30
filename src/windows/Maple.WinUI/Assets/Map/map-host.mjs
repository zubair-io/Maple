import { Map, Marker, NavigationControl } from './vendor/maplibre-gl.mjs';

let map;
let pins = [];
const send = (message) => window.chrome.webview.postMessage(message);
const wrap = (value) => ((((value + 180) % 360) + 360) % 360) - 180;

function viewport() {
  const bounds = map.getBounds();
  const wholeWorld = bounds.getEast() - bounds.getWest() >= 360;
  send({
    type: 'viewport',
    west: wholeWorld ? -180 : wrap(bounds.getWest()),
    east: wholeWorld ? 180 : wrap(bounds.getEast()),
    south: Math.max(-90, bounds.getSouth()),
    north: Math.min(90, bounds.getNorth()),
    zoom: Math.max(0, Math.min(20, Math.floor(map.getZoom()))),
  });
}

window.chrome.webview.addEventListener('message', ({ data }) => {
  if (data.type === 'configure' && !map) {
    const tileUrl = data.tileUrl;
    const raster = ['{z}', '{x}', '{y}'].every((part) => tileUrl.includes(part));
    const style = raster
      ? {
          version: 8,
          sources: {
            tiles: {
              type: 'raster',
              tiles: [tileUrl],
              tileSize: 256,
              attribution: tileUrl.includes('tile.openstreetmap.org/')
                ? '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
                : '',
            },
          },
          layers: [{ id: 'tiles', type: 'raster', source: 'tiles' }],
        }
      : tileUrl;
    map = new Map({ container: 'map', style, center: [0, 20], zoom: 1, maxZoom: 20 });
    map.addControl(new NavigationControl(), 'top-right');
    map.on('load', viewport);
    map.on('moveend', viewport);
    map.on('error', () => send({ type: 'tileError' }));
    new ResizeObserver(() => map.resize()).observe(document.getElementById('map'));
  } else if (data.type === 'cells' && map) {
    for (const pin of pins) pin.remove();
    pins = data.cells.map((cell, index) => {
      const button = document.createElement('button');
      button.className = 'pin';
      button.textContent = String(cell.count);
      button.setAttribute(
        'aria-label',
        `${cell.count} photos${cell.placeLabel ? ` near ${cell.placeLabel}` : ''}`,
      );
      button.addEventListener('click', () =>
        send({ type: 'select', index, generation: data.generation }),
      );
      return new Marker({ element: button }).setLngLat([cell.lng, cell.lat]).addTo(map);
    });
  } else if (data.type === 'retry' && map) {
    map.setStyle(map.getStyle());
    viewport();
  }
});
send({ type: 'ready' });
