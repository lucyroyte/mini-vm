// Summer surface temperature from Landsat 8/9 thermal imagery, averaged over a
// few clear summer days and stored in the repo as a small grayscale PNG by
// tools/landsat_lst.py. Pixel value = (°F − 60) × 4; 0 = no data.

const URL = 'data/heat/brooklyn-lst-summer';
export const SURFACE_TEMP_SOURCE = 'https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature';

// Returns a function (lon, lat) => °F, or NaN where there's no data.
export async function loadSurfaceTemperature(decode = decodePNG) {
  const meta = await (await fetch(`${URL}.json`)).json();
  const res = await fetch(`${URL}.png`);
  if (!res.ok) throw new Error(`${res.status} loading surface temperature`);
  const pixels = await decode(await res.blob(), meta.width, meta.height);
  const [w, s, e, n] = meta.bbox;
  return (lon, lat) => {
    const x = Math.floor(((lon - w) / (e - w)) * meta.width), y = Math.floor(((n - lat) / (n - s)) * meta.height);
    if (x < 0 || y < 0 || x >= meta.width || y >= meta.height) return NaN;
    const v = pixels[y * meta.width + x];
    return v ? 60 + v / 4 : NaN;
  };
}

async function decodePNG(blob, width, height) {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4];
  return out;
}
