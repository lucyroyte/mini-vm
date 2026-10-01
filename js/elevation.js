// Ground elevation from the AWS Terrain Tiles (USGS 3DEP lidar in NYC),
// decoded from Terrarium-encoded PNGs. NYC Open Data publishes its 1-foot DEM
// only as a multi-gigabyte raster download, which is too large for a browser.

const ZOOM = 13;
const URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const ELEVATION_SOURCE = 'https://registry.opendata.aws/terrain-tiles/';

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

async function loadTile(x, y) {
  const res = await fetch(URL(ZOOM, x, y), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`terrain tile ${x},${y}: ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(256, 256);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, 256, 256);
  const meters = new Float32Array(256 * 256);
  for (let i = 0; i < meters.length; i++) {
    meters[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
  }
  return meters;
}

// Returns a function (lon, lat) => elevation in feet.
export async function loadElevation([w, s, e, n]) {
  const x0 = Math.floor(lon2x(w, ZOOM)), x1 = Math.floor(lon2x(e, ZOOM));
  const y0 = Math.floor(lat2y(n, ZOOM)), y1 = Math.floor(lat2y(s, ZOOM));
  const tiles = new Map();
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(loadTile(x, y).then((t) => tiles.set(`${x}/${y}`, t)));
  }
  await Promise.all(jobs);
  return (lon, lat) => {
    const fx = lon2x(lon, ZOOM), fy = lat2y(lat, ZOOM);
    const tile = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
    if (!tile) return NaN;
    const px = Math.min(255, Math.floor((fx % 1) * 256)), py = Math.min(255, Math.floor((fy % 1) * 256));
    return tile[py * 256 + px] * 3.28084;
  };
}
