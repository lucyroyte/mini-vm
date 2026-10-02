// What the ground is actually covered by, measured from the air: NYC's 2017
// land cover, classified at 6 inches from lidar and aerial imagery, reduced to
// a 12 m map of Brooklyn by tools/nyc_landcover.py and stored in data/landcover/.
// Each pixel holds the share of tree canopy (red), grass and shrub (green) and
// paved or roofed surface (blue), × 250; 255,255,255 is outside the city.

export const LANDCOVER_SOURCE = 'https://data.cityofnewyork.us/d/he6d-2qns';
const URL = 'data/landcover/brooklyn-landcover-2017';

// Returns { bbox, width, height, rgba }, read by buildGrid.
export async function loadLandCover(decode = decodePNG) {
  const meta = await (await fetch(`${URL}.json`)).json();
  const res = await fetch(`${URL}.png`);
  if (!res.ok) throw new Error(`${res.status} loading ${URL}.png`);
  return { ...meta, rgba: await decode(await res.blob(), meta.width, meta.height) };
}

async function decodePNG(blob, width, height) {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, width, height).data;
}
