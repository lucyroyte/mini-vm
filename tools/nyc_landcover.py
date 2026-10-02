"""Builds the app's land cover map of Brooklyn from NYC's 2017 6-inch land
cover, classified from 2017 lidar and 2016 aerial imagery
(https://data.cityofnewyork.us/d/he6d-2qns).

    python3 -m pip install rasterio numpy pillow
    curl -L -o Land_Cover.zip 'https://data.cityofnewyork.us/api/views/he6d-2qns/files/64c49dc7-c17f-43db-a4e3-669a28f73234?filename=Land_Cover.zip'
    unzip Land_Cover.zip 'Land_Cover/*.img' 'Land_Cover/*.rrd'
    python3 tools/nyc_landcover.py Land_Cover/NYC_2017_LiDAR_LandCover.img data/landcover/brooklyn-landcover-2017

The full-resolution raster is 98 GB unzipped, so this reads the 4 ft pyramid
level in the .rrd file (2 GB) instead. Its pyramids are nearest-neighbor
samples, so the share of each class in a 12 m pixel is still an unbiased
estimate. Writes <out>.png, an RGB image of the share of each pixel that is
tree canopy (red), grass and shrub (green) and paved or roofed (blue:
buildings, roads and other impervious surfaces), each as share × 250, with
255,255,255 = no data; and <out>.json with its bounds. Whatever is left is
bare soil, water or railroad.
"""

import json
import sys

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import Window, from_bounds

BBOX = (-74.06, 40.565, -73.83, 40.745)  # matches BROOKLYN_BBOX in js/data.js
RES = (0.00015, 0.00011)  # degrees lon, lat: about 12.7 m × 12.2 m
OVERVIEW = 2  # pyramid level: 4 ft pixels
BLOCK = 10  # 4 ft pixels per aggregated pixel side (40 ft)
CHUNK = 4000  # rows read at a time, a multiple of BLOCK
# Classes: 1 tree canopy, 2 grass/shrub, 3 bare soil, 4 water, 5 buildings,
# 6 roads, 7 other impervious, 8 railroads; 0 = outside the city.
CHANNELS = [(1,), (2,), (5, 6, 7)]


def main(src_path, out):
    with rasterio.open(src_path, overview_level=OVERVIEW) as src:
        win = from_bounds(*transform_bounds('EPSG:4326', src.crs, *BBOX), src.transform)
        win = Window(int(win.col_off) // BLOCK * BLOCK, int(win.row_off) // BLOCK * BLOCK,
                     (int(win.width) // BLOCK + 2) * BLOCK, (int(win.height) // BLOCK + 2) * BLOCK)
        win = win.intersection(Window(0, 0, src.width // BLOCK * BLOCK, src.height // BLOCK * BLOCK))
        bh, bw = int(win.height) // BLOCK, int(win.width) // BLOCK
        shares = np.zeros((len(CHANNELS) + 1, bh, bw), dtype='float32')  # last = inside the city
        totals = np.zeros(9)
        for r0 in range(0, bh * BLOCK, CHUNK):
            h = min(CHUNK, bh * BLOCK - r0)
            a = src.read(1, window=Window(win.col_off, win.row_off + r0, bw * BLOCK, h))
            totals += np.bincount(a.ravel(), minlength=9)[:9]
            blocks = lambda m: m.reshape(h // BLOCK, BLOCK, bw, BLOCK).mean(axis=(1, 3))
            rows = slice(r0 // BLOCK, (r0 + h) // BLOCK)
            for c, classes in enumerate(CHANNELS):
                shares[c, rows] = blocks(np.isin(a, classes))
            shares[-1, rows] = blocks(a > 0)
            print(f'rows {r0 + h:,} / {bh * BLOCK:,}', end='\r')
        print()
        block_transform = src.window_transform(win) * rasterio.Affine.scale(BLOCK)
        crs = src.crs

    w, s, e, n = BBOX
    width, height = round((e - w) / RES[0]), round((n - s) / RES[1])
    dst = np.full((len(shares), height, width), np.nan, dtype='float32')
    reproject(shares, dst, src_transform=block_transform, src_crs=crs, dst_transform=from_origin(w, n, *RES),
              dst_crs='EPSG:4326', dst_nodata=np.nan, resampling=Resampling.average)
    inside = dst[-1]
    ok = np.isfinite(inside) & (inside > 0.5)
    with np.errstate(all='ignore'):
        rgb = np.stack([np.clip(np.round(dst[c] / inside * 250), 0, 250) for c in range(len(CHANNELS))], axis=-1)
    rgb[~ok] = 255
    Image.fromarray(rgb.astype('uint8'), mode='RGB').save(f'{out}.png', optimize=True)
    with open(f'{out}.json', 'w') as fh:
        json.dump({
            'bbox': BBOX, 'width': width, 'height': height,
            'encoding': 'R tree canopy, G grass/shrub, B buildings+roads+other impervious; share * 250; 255,255,255 = no data',
            'source': 'NYC 2017 6-inch land cover (lidar and 2016 orthoimagery), NYC Open Data he6d-2qns, 4 ft pyramid level',
        }, fh, indent=1)
    names = ['outside', 'tree canopy', 'grass/shrub', 'bare soil', 'water', 'buildings', 'roads', 'other impervious', 'railroads']
    inside_total = totals[1:].sum()
    print(f'{width}×{height}. Within the window: ' + ', '.join(f'{nm} {100 * totals[i] / inside_total:.1f}%' for i, nm in enumerate(names) if i))


if __name__ == '__main__':
    main(*sys.argv[1:])
