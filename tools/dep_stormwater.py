"""Rasterizes NYC's Stormwater Flood Maps (NYC DEP / Mayor's Office of Climate
and Environmental Justice, made with a city-wide sewer and surface model) for
Brooklyn, for the app's stormwater model.

    curl -L -o dep.zip 'https://data.cityofnewyork.us/download/9i7c-xyvv/application%2Fzip'
    unzip dep.zip -d dep
    python3 -m pip install geopandas rasterio pillow
    python3 tools/dep_stormwater.py dep data/flood/dep-stormwater

Writes <out>.png, an RGB image whose red channel is the Moderate Flood map
(2.13 in/hr, current sea levels) and green channel the Extreme Flood map
(3.66 in/hr, 2080 sea level rise): 0 = dry, 1 = nuisance flooding (4 in to
1 ft), 2 = deep and contiguous flooding (over 1 ft). The maps' third class,
future high tides, is left to the app's coastal model. <out>.json has the bounds.
(The Limited Flood map is stored in a compressed format GDAL can't read.)
"""

import glob
import json
import sys

import geopandas as gpd
import numpy as np
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_origin

BBOX = (-74.06, 40.565, -73.83, 40.745)  # matches BROOKLYN_BBOX in js/data.js
RES = (0.0001, 0.000075)  # degrees lon, lat: about 8.4 m × 8.3 m
MAPS = {'Moderate_Flood_2_13_inches_per_hr_with_Current': 0, 'Extreme_Flood_3_66_inches_per_hr_with_2080': 1}


def main(src, out):
    w, s, e, n = BBOX
    width, height = round((e - w) / RES[0]), round((n - s) / RES[1])
    transform = from_origin(w, n, *RES)
    rgb = np.zeros((height, width, 3), dtype='uint8')
    for gdb in glob.glob(f'{src}/**/*.gdb', recursive=True):
        band = next((b for key, b in MAPS.items() if key in gdb), None)
        if band is None:
            continue
        df = gpd.read_file(gdb).to_crs(4326)
        df = df[df.Flooding_Category.isin([1, 2])].sort_values('Flooding_Category')
        rgb[:, :, band] = rasterize(
            ((g, int(c)) for g, c in zip(df.geometry, df.Flooding_Category)),
            out_shape=(height, width), transform=transform, fill=0, dtype='uint8')
        print(gdb.split('/')[-1], {c: int((rgb[:, :, band] == c).sum()) for c in (1, 2)})
    Image.fromarray(rgb, mode='RGB').save(f'{out}.png', optimize=True)
    with open(f'{out}.json', 'w') as fh:
        json.dump({
            'bbox': BBOX, 'width': width, 'height': height,
            'bands': {'r': 'Moderate Flood, 2.13 in/hr, current sea levels', 'g': 'Extreme Flood, 3.66 in/hr, 2080 sea level rise'},
            'values': {'0': 'dry', '1': 'nuisance flooding, 4 in to 1 ft', '2': 'deep and contiguous flooding, over 1 ft'},
            'source': 'NYC Stormwater Flood Maps, NYC Open Data 9i7c-xyvv',
        }, fh, indent=1)
    print(f'{width}×{height}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
