// Geometry helpers: a local metric projection and fast scanline rasterization
// of GeoJSON onto the analysis grid.

// Equirectangular projection centered on Brooklyn. Over ~20 km the distortion
// is well under 0.1%, so a 100 m cell in this plane is a 100 m cell on the ground.
export function makeProjection(lon0, lat0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  return {
    toXY: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: (x, y) => [lon0 + x / kx, lat0 + y / ky],
  };
}

// Yields arrays of rings (each ring an array of [lon, lat]) for every polygon in a geometry.
export function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  if (geom.type === 'GeometryCollection') return geom.geometries.flatMap(polygonsOf);
  return [];
}

export function linesOf(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  if (geom.type === 'GeometryCollection') return geom.geometries.flatMap(linesOf);
  return [];
}

export function bboxOf(features) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < b[0]) b[0] = c[0];
      if (c[1] < b[1]) b[1] = c[1];
      if (c[0] > b[2]) b[2] = c[0];
      if (c[1] > b[3]) b[3] = c[1];
    } else c.forEach(visit);
  };
  for (const f of features) if (f.geometry) visit(f.geometry.coordinates ?? f.geometry.geometries.map((g) => g.coordinates));
  return b;
}

export function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// Rasterizes polygon features onto a sample lattice with even-odd filling.
// lattice: { x0, y0, step, cols, rows } in projected meters; sample (c, r) sits at
// (x0 + (c + 0.5) * step, y0 + (r + 0.5) * step).
// For each sample inside a feature, write(index, feature) is called.
export function rasterizePolygons(features, lattice, proj, write) {
  const { x0, y0, step, cols, rows } = lattice;
  for (const f of features) {
    for (const rings of polygonsOf(f.geometry)) {
      // Project and bucket crossings by sample row.
      const projected = rings.map((ring) => ring.map(([lon, lat]) => proj.toXY(lon, lat)));
      let ymin = Infinity, ymax = -Infinity;
      for (const ring of projected) for (const p of ring) {
        if (p[1] < ymin) ymin = p[1];
        if (p[1] > ymax) ymax = p[1];
      }
      const r0 = Math.max(0, Math.ceil((ymin - y0) / step - 0.5));
      const r1 = Math.min(rows - 1, Math.floor((ymax - y0) / step - 0.5));
      if (r1 < r0) continue;
      const crossings = Array.from({ length: r1 - r0 + 1 }, () => []);
      for (const ring of projected) {
        for (let i = 0, n = ring.length; i < n; i++) {
          const a = ring[i], b = ring[(i + 1) % n];
          if (a[1] === b[1]) continue;
          const [lo, hi] = a[1] < b[1] ? [a, b] : [b, a];
          const ra = Math.max(r0, Math.ceil((lo[1] - y0) / step - 0.5));
          const rb = Math.min(r1, Math.ceil((hi[1] - y0) / step - 0.5) - 1);
          for (let r = ra; r <= rb; r++) {
            const y = y0 + (r + 0.5) * step;
            crossings[r - r0].push(lo[0] + ((y - lo[1]) / (hi[1] - lo[1])) * (hi[0] - lo[0]));
          }
        }
      }
      for (let k = 0; k < crossings.length; k++) {
        const xs = crossings[k].sort((p, q) => p - q);
        const r = r0 + k;
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const c0 = Math.max(0, Math.ceil((xs[i] - x0) / step - 0.5));
          const c1 = Math.min(cols - 1, Math.floor((xs[i + 1] - x0) / step - 0.5));
          for (let c = c0; c <= c1; c++) write(r * cols + c, f);
        }
      }
    }
  }
}

// Marks every lattice cell touched by the lines of the given features.
export function rasterizeLines(features, lattice, proj, write) {
  const { x0, y0, step, cols, rows } = lattice;
  for (const f of features) {
    for (const line of linesOf(f.geometry)) {
      for (let i = 0; i + 1 < line.length; i++) {
        const [ax, ay] = proj.toXY(...line[i]);
        const [bx, by] = proj.toXY(...line[i + 1]);
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (step / 2)));
        for (let s = 0; s <= n; s++) {
          const c = Math.floor((ax + ((bx - ax) * s) / n - x0) / step);
          const r = Math.floor((ay + ((by - ay) * s) / n - y0) / step);
          if (c >= 0 && r >= 0 && c < cols && r < rows) write(r * cols + c, f);
        }
      }
    }
  }
}
