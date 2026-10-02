"""Convert an NYC 3D Model community-district .3dm file to a .glb for the web map.

The DCP files store buildings as surfaces (Breps/extrusions), and rhino3dm cannot
mesh those itself. Most faces are planar, so we triangulate each face's trim
loops directly; curved faces fall back to a grid sampled over the surface.
Coordinates are reprojected from NY State Plane Long Island (EPSG:2263, US feet)
to metres in a local frame centred on the model, with Y up as glTF expects.

Heights in the model are absolute elevations. With --ground (the default), each
face is lowered by the ground height of the building footprint under it, so the
buildings stand on a flat map; pass --no-ground to keep absolute heights for a
map with terrain.

usage: python3 rhino_to_glb.py IN.3dm OUT.glb [--layers substr,substr] [--crs EPSG:2263] [--no-ground]
"""
import argparse
import json
import math
import sys
from collections import Counter, defaultdict

import mapbox_earcut as earcut
import numpy as np
import rhino3dm as r
import trimesh
from pyproj import Transformer
from shapely import STRtree, Point, Polygon

FT_US = 1200 / 3937  # metres per US survey foot
LAYER_COLOURS = {'Surface_Facade': [214, 208, 198, 255], 'Surface_RoofTop': [168, 164, 158, 255]}
UNIT_TO_M = {'Feet': FT_US, 'Meters': 1.0, 'Millimeters': 0.001, 'Inches': 0.0254}


def edge_points(brep, trim, samples=8):
    e = brep.Edges[trim.EdgeIndex]
    if e.IsLinear():
        pts = [e.PointAtStart, e.PointAtEnd]
    else:
        pl = e.TryGetPolyline()  # a Polyline, or None
        if pl is not None and pl.Count >= 2:
            pts = [pl[i] for i in range(pl.Count)]
        else:
            d = e.Domain
            pts = [e.PointAt(d.T0 + (d.T1 - d.T0) * i / samples) for i in range(samples + 1)]
    pts = [(p.X, p.Y, p.Z) for p in pts]
    return pts[::-1] if trim.IsReversed else pts


def loop_polygon(brep, loop):
    ring = []
    for i in range(loop.TrimCount):
        trim = loop.Trims[i]
        if trim.EdgeIndex < 0:  # singular trim, no 3D edge
            continue
        ring.extend(edge_points(brep, trim)[:-1])
    return np.array(ring, dtype=float)


def plane_basis(ring):
    """Newell normal and two in-plane axes for a 3D ring."""
    n = np.zeros(3)
    for a, b in zip(ring, np.roll(ring, -1, axis=0)):
        n += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    norm = np.linalg.norm(n)
    if norm == 0:
        return None
    n /= norm
    u = np.cross(n, [0, 0, 1] if abs(n[2]) < 0.9 else [1, 0, 0])
    u /= np.linalg.norm(u)
    return n, u, np.cross(n, u)


def planar_face_mesh(brep, face):
    loops = [face.Loops[i] for i in range(len(face.Loops))]
    rings = [loop_polygon(brep, lp) for lp in loops]
    rings = [rg for rg in rings if len(rg) >= 3]
    if not rings:
        return None
    # Outer loop first (largest area), holes after.
    basis = plane_basis(max(rings, key=len))
    if basis is None:
        return None
    _, u, v = basis
    area = lambda rg: abs(np.sum((rg @ u) * np.roll(rg @ v, -1) - np.roll(rg @ u, -1) * (rg @ v))) / 2
    rings.sort(key=area, reverse=True)
    verts = np.vstack(rings)
    flat = np.column_stack([verts @ u, verts @ v])
    ends = np.cumsum([len(rg) for rg in rings]).astype(np.uint32)
    tris = earcut.triangulate_float64(flat, ends).reshape(-1, 3)
    if len(tris) == 0:
        return None
    return verts, tris


def grid_face_mesh(face, n=12):
    du, dv = face.Domain(0), face.Domain(1)
    pts, tris = [], []
    for i in range(n + 1):
        for j in range(n + 1):
            p = face.PointAt(du.T0 + (du.T1 - du.T0) * i / n, dv.T0 + (dv.T1 - dv.T0) * j / n)
            pts.append((p.X, p.Y, p.Z))
    for i in range(n):
        for j in range(n):
            a = i * (n + 1) + j
            tris += [(a, a + n + 1, a + 1), (a + 1, a + n + 1, a + n + 2)]
    return np.array(pts), np.array(tris)


def cached_mesh(obj):
    m = obj.GetMesh(r.MeshType.Any)
    if m is None or m.Faces.Count == 0:
        return None
    return mesh_from_rhino_mesh(m)


def mesh_from_rhino_mesh(m):
    m.Faces.ConvertQuadsToTriangles()
    v = np.array([(p.X, p.Y, p.Z) for p in m.Vertices])
    f = np.array([m.Faces[i][:3] for i in range(m.Faces.Count)])
    return v, f


def brep_meshes(brep, stats):
    for i in range(len(brep.Faces)):
        face = brep.Faces[i]
        got = cached_mesh(face)
        if got:
            stats['face: cached mesh'] += 1
        elif face.IsPlanar():
            got = planar_face_mesh(brep, face)
            stats['face: planar' if got else 'face: planar failed'] += 1
        if not got:
            got = grid_face_mesh(face)
            stats['face: sampled grid'] += 1
        yield got


def geometry_meshes(geom, stats):
    stats[type(geom).__name__] += 1
    if isinstance(geom, r.Mesh):
        yield mesh_from_rhino_mesh(geom)
    elif isinstance(geom, r.Extrusion):
        got = cached_mesh(geom)
        if got:
            stats['extrusion: cached mesh'] += 1
            yield got
        else:
            yield from brep_meshes(geom.ToBrep(True), stats)
    elif isinstance(geom, r.Brep):
        yield from brep_meshes(geom, stats)
    elif isinstance(geom, r.Surface):
        yield from brep_meshes(r.Brep.CreateFromSurface(geom), stats)


class Ground:
    """Ground height lookup from the 2D footprint outlines, which sit at ground level."""

    def __init__(self, model, layers, layer_name):
        polys, heights = [], []
        for obj in model.Objects:
            g = obj.Geometry
            if not layers.get(obj.Attributes.LayerIndex, '').endswith(layer_name) or not isinstance(g, r.PolylineCurve):
                continue
            pts = [g.Point(i) for i in range(g.PointCount)]
            if len(pts) < 4:
                continue
            poly = Polygon([(p.X, p.Y) for p in pts])
            if poly.is_valid and poly.area > 0:
                polys.append(poly)
                heights.append(min(p.Z for p in pts))
        self.heights = np.array(heights)
        self.tree = STRtree(polys) if polys else None

    def __len__(self):
        return len(self.heights)

    def at(self, x, y):
        pt = Point(x, y)
        hits = self.tree.query(pt, predicate='intersects')
        # Inside a footprint (roofs), else the nearest one (facades sit on outlines).
        i = hits[0] if len(hits) else self.tree.nearest(pt)
        return self.heights[i]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--layers', help='comma-separated substrings of layer names to keep (default: all)')
    ap.add_argument('--crs', default='EPSG:2263', help='source CRS of the model coordinates')
    ap.add_argument('--no-ground', dest='ground', action='store_false', help='keep absolute elevations')
    ap.add_argument('--ground-layer', default='Building_FootPrint', help='layer of 2D footprint outlines at ground level')
    args = ap.parse_args()

    model = r.File3dm.Read(args.src)
    if model is None:
        sys.exit(f'could not read {args.src}')
    units = str(model.Settings.ModelUnitSystem).split('.')[-1]
    layers = {model.Layers[i].Index: model.Layers[i].FullPath for i in range(len(model.Layers))}
    keep = [s.strip().lower() for s in args.layers.split(',')] if args.layers else None

    ground = Ground(model, layers, args.ground_layer) if args.ground else None
    if ground is not None and not len(ground):
        sys.exit(f'no footprint outlines on a layer ending in {args.ground_layer!r}; pass --no-ground')

    stats = Counter()
    per_layer = defaultdict(lambda: ([], []))  # layer -> (vertex arrays, face arrays)
    attrs = []
    for obj in model.Objects:
        layer = layers.get(obj.Attributes.LayerIndex, '?')
        if keep and not any(k in layer.lower() for k in keep):
            stats['skipped (layer filter)'] += 1
            continue
        n_before = len(per_layer[layer][0])
        for got in geometry_meshes(obj.Geometry, stats):
            if got and len(got[1]):
                if ground is not None:
                    v = got[0].copy()
                    cx_, cy_ = v[:, :2].mean(0)
                    v[:, 2] -= ground.at(cx_, cy_)
                    got = (v, got[1])
                per_layer[layer][0].append(got[0])
                per_layer[layer][1].append(got[1])
        if len(per_layer[layer][0]) > n_before and len(attrs) < 20:
            attrs.append({'layer': layer, 'name': obj.Attributes.Name,
                          'user_strings': dict(obj.Attributes.GetUserStrings2() or {})})

    all_v = [v for vs, _ in per_layer.values() for v in vs]
    if not all_v:
        sys.exit(f'no mesh geometry produced; object types seen: {dict(stats)}')
    allpts = np.vstack(all_v)
    lo, hi = allpts.min(0), allpts.max(0)
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    lon0, lat0 = Transformer.from_crs(args.crs, 'EPSG:4326', always_xy=True).transform(cx, cy)
    # Local transverse Mercator centred on the model: metres, negligible distortion over a district.
    to_local = Transformer.from_crs(args.crs, f'+proj=tmerc +lat_0={lat0} +lon_0={lon0} +k=1 +x_0=0 +y_0=0 +units=m +ellps=GRS80', always_xy=True)
    zscale = UNIT_TO_M.get(units, FT_US)

    scene = trimesh.Scene()
    tri_count = 0
    for layer, (vs, fs) in per_layer.items():
        if not vs:
            continue
        offs = np.cumsum([0] + [len(v) for v in vs[:-1]])
        v = np.vstack(vs)
        f = np.vstack([fa + o for fa, o in zip(fs, offs)])
        e, n = to_local.transform(v[:, 0], v[:, 1])
        local = np.column_stack([e, v[:, 2] * zscale, -np.asarray(n)])  # glTF: x east, y up, z south
        mesh = trimesh.Trimesh(local, f, process=True)
        # Faces come as separate surfaces with no consistent winding, so draw both sides.
        mesh.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(
            name=layer, baseColorFactor=LAYER_COLOURS.get(layer.split('::')[-1], [200, 200, 200, 255]),
            metallicFactor=0.0, roughnessFactor=0.9, doubleSided=True))
        tri_count += len(mesh.faces)
        scene.add_geometry(mesh, node_name=layer, geom_name=layer)
    scene.export(args.dst)

    report = {
        'source': args.src, 'units': units, 'crs': args.crs,
        'heights': 'above footprint ground' if ground is not None else 'absolute elevation',
        'origin_lonlat': [lon0, lat0],
        'bbox_source_units': [lo.tolist(), hi.tolist()],
        'extent_m': [(hi[0] - lo[0]) * FT_US, (hi[1] - lo[1]) * FT_US, (hi[2] - lo[2]) * zscale],
        'faces_per_layer': {k: len(vs) for k, (vs, _) in per_layer.items() if vs},
        'triangles': tri_count, 'geometry_stats': dict(stats), 'sample_attributes': attrs,
    }
    with open(args.dst.rsplit('.', 1)[0] + '.json', 'w') as fh:
        json.dump(report, fh, indent=2, default=str)
    print(json.dumps({k: report[k] for k in ('units', 'origin_lonlat', 'extent_m', 'faces_per_layer', 'triangles', 'geometry_stats')}, indent=2, default=str))


if __name__ == '__main__':
    main()
