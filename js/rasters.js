// Rasters stored in the repo as small PNGs, each with a .json file giving its
// lon/lat bounds and size, sampled by the grid when it's built.
//
// - Summer surface temperature from Landsat 8/9 thermal imagery, averaged over
//   a few clear summer days (tools/landsat_lst.py). Gray value = (°F − 60) × 4;
//   0 = no data.
// - NYC's Stormwater Flood Maps (tools/dep_stormwater.py). Red = moderate flood
//   (2.13 in/hr), green = extreme flood (3.66 in/hr): 0 dry, 1 = 4 in to 1 ft,
//   2 = over 1 ft.

export const SURFACE_TEMP_SOURCE = 'https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature';
export const STORMWATER_SOURCE = 'https://data.cityofnewyork.us/d/9i7c-xyvv';

// Returns a function (lon, lat, channel) => pixel value, or -1 outside the image.
async function loadRaster(url, decode) {
  const meta = await (await fetch(`${url}.json`)).json();
  const res = await fetch(`${url}.png`);
  if (!res.ok) throw new Error(`${res.status} loading ${url}.png`);
  const rgba = await decode(await res.blob(), meta.width, meta.height);
  const [w, s, e, n] = meta.bbox;
  return (lon, lat, channel = 0) => {
    const x = Math.floor(((lon - w) / (e - w)) * meta.width), y = Math.floor(((n - lat) / (n - s)) * meta.height);
    if (x < 0 || y < 0 || x >= meta.width || y >= meta.height) return -1;
    return rgba[(y * meta.width + x) * 4 + channel];
  };
}

// (lon, lat) => °F, or NaN where there's no data.
export async function loadSurfaceTemperature(decode = decodePNG) {
  const px = await loadRaster('data/heat/brooklyn-lst-summer', decode);
  return (lon, lat) => {
    const v = px(lon, lat);
    return v > 0 ? 60 + v / 4 : NaN;
  };
}

// (lon, lat, storm) => 0 dry, 1 shallow, 2 deep; storm 0 = moderate, 1 = extreme.
export async function loadStormwaterMaps(decode = decodePNG) {
  const px = await loadRaster('data/flood/dep-stormwater', decode);
  return (lon, lat, storm) => Math.max(0, px(lon, lat, storm));
}

async function decodePNG(blob, width, height) {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, width, height).data;
}
