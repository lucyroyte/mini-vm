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
