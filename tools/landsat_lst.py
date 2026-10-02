"""Builds the app's summer surface temperature map of Brooklyn from Landsat 8/9
Collection 2 Level-2 surface temperature (band ST_B10), read from Microsoft's
Planetary Computer.

    python3 -m pip install rasterio numpy pillow
    python3 tools/landsat_lst.py data/heat/brooklyn-lst-summer

Averages a few nearly cloud-free summer scenes (path 13, row 32, about
11:30 am local time), masks clouds and shadows with QA_PIXEL, and reprojects
to a lon/lat grid. Writes <out>.png, an 8-bit grayscale image where
value = (°F − 60) × 4 and 0 = no data, and <out>.json with its bounds.
"""

import json
import sys
import urllib.request

import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import from_bounds
from rasterio.transform import from_origin

BBOX = (-74.06, 40.565, -73.83, 40.745)  # matches BROOKLYN_BBOX in js/data.js
RES = (0.0004, 0.0003)  # degrees lon, lat: about 34 m × 33 m
BASE = 'https://landsateuwest.blob.core.windows.net/landsat-c2/level-2/standard/oli-tirs/'
SCENES = [
    '2023/013/032/LC08_L2SP_013032_20230809_20230812_02_T1/LC08_L2SP_013032_20230809_20230812_02_T1',
    '2024/013/032/LC09_L2SP_013032_20240702_20240703_02_T1/LC09_L2SP_013032_20240702_20240703_02_T1',
    '2024/013/032/LC08_L2SP_013032_20240827_20240831_02_T1/LC08_L2SP_013032_20240827_20240831_02_T1',
    '2025/013/032/LC09_L2SP_013032_20250822_20250823_02_T1/LC09_L2SP_013032_20250822_20250823_02_T1',
]


def main(out):
    token = json.load(urllib.request.urlopen('https://planetarycomputer.microsoft.com/api/sas/v1/token/landsat-c2-l2'))['token']
    w, s, e, n = BBOX
    width, height = round((e - w) / RES[0]), round((n - s) / RES[1])
    dst_transform = from_origin(w, n, *RES)
    layers = []
    for scene in SCENES:
        with rasterio.open(f'/vsicurl/{BASE}{scene}_ST_B10.TIF?{token}') as st, \
             rasterio.open(f'/vsicurl/{BASE}{scene}_QA_PIXEL.TIF?{token}') as qa:
            win = from_bounds(*transform_bounds('EPSG:4326', st.crs, *BBOX), st.transform).round_offsets().round_lengths()
            dn = st.read(1, window=win).astype('float32')
            q = qa.read(1, window=win)
            f = (dn * 0.00341802 + 149.0 - 273.15) * 9 / 5 + 32
            cloudy = ((q >> 1) & 1) | ((q >> 3) & 1) | ((q >> 4) & 1)  # dilated cloud, cloud, shadow
            f[(dn == 0) | (cloudy == 1)] = np.nan
            dst = np.full((height, width), np.nan, dtype='float32')
            reproject(f, dst, src_transform=st.window_transform(win), src_crs=st.crs, src_nodata=np.nan,
                      dst_transform=dst_transform, dst_crs='EPSG:4326', dst_nodata=np.nan, resampling=Resampling.bilinear)
            layers.append(dst)
            print(scene.split('/')[-1], f'median {np.nanmedian(dst):.1f} °F')
    with np.errstate(all='ignore'):
        mean = np.nanmean(np.stack(layers), axis=0)
    code = np.where(np.isfinite(mean), np.clip(np.round((mean - 60) * 4), 1, 255), 0).astype('uint8')
    Image.fromarray(code, mode='L').save(f'{out}.png', optimize=True)
    with open(f'{out}.json', 'w') as fh:
        json.dump({
            'bbox': BBOX, 'width': width, 'height': height, 'encoding': 'value = (degF - 60) * 4; 0 = no data',
            'source': 'Landsat 8/9 Collection 2 Level-2 surface temperature (ST_B10), USGS, via Microsoft Planetary Computer',
            'scenes': [s.split('/')[-1] for s in SCENES],
        }, fh, indent=1)
    print(f'{width}×{height}, mean {np.nanmean(mean):.1f} °F')


if __name__ == '__main__':
    main(sys.argv[1])
