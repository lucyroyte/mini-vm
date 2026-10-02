# Converting the NYC 3D Model

`rhino_to_glb.py` turns one community district of NYC Planning's *NYC 3D Model* (a Rhino `.3dm` file) into a glTF file for the app's 3D view. It doesn't need Rhino. Each building surface in the files has a saved render mesh, and the script reads those meshes with the `rhino3dm` library. Any surface without one is triangulated by the script.

```sh
python3 -m pip install rhino3dm pyproj trimesh numpy scipy mapbox-earcut shapely
python3 tools/rhino_to_glb.py NYC_3DModel_BK02.3dm bk02.glb --layers surface_roof,surface_facade
npx @gltf-transform/cli meshopt bk02.glb data/3d/bk02.glb   # 8.7 MB → 1.7 MB
```

Then add the district to `data/3d/models.json`, with `origin_lonlat` taken from the `.json` stats file the script writes next to its output.

How the script handles the model:

- **Coordinates.** It reprojects from NY State Plane Long Island (EPSG:2263, US feet) to metres around the district's centre. In the output, x points east, y points up and z points south.
- **Heights.** The model's heights are absolute elevations. The script lowers each face by the ground height of the nearest building footprint (the `Building_FootPrint` layer), so buildings stand on the flat map. Pass `--no-ground` to keep absolute heights for a map with terrain.
- **Layers.** Only roofs and facades are kept. Footprint surfaces are hidden under the buildings anyway, and the context layers (roads, parks, contours) are 2D lines only.
- **No building IDs.** The model has no BIN or other ID, so buildings can't be linked to footprints or tax lots.
- **Data age.** The model comes from a 2014 survey, so newer buildings are missing.

# Census blocks and Landsat heat

`census_blocks.py` writes `data/census/brooklyn-blocks-2020.json`, the 2020 Census population and housing units of each Brooklyn block, from the Census Bureau's PL 94-171 file (see the script for the download). The Census API now needs a key, so the app ships this small file instead.

`landsat_lst.py` writes `data/heat/brooklyn-lst-summer.png` and `.json`: Landsat 8/9 surface temperature averaged over four clear summer days in 2023–2025, read from Microsoft's Planetary Computer. Landsat passes over at about 11:30 am, so this is late-morning surface temperature, hotter than the air.

**Fitting the heat model.** `HEAT.tRef` and `HEAT.uhiMax` in `js/models.js` come from a least-squares fit of each land cell's Landsat temperature against the model's 1 − heat mitigation for today's Brooklyn (69,460 cells): LST = 81.3 + 25.5 × (1 − HM), r = 0.57. NYC's *Hyperlocal Temperature Monitoring* sensors (166 in Brooklyn, summers 2018–2019) were also tried. They sit only in dense neighborhoods, so they don't span enough of the model's range to fit it, but sensors hung in street trees read 3.3 °F cooler on July and August afternoons than those on light poles (allowing for year and modeled heat), which supports the model's weight on shade.
