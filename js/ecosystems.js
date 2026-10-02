// Ecosystem types. Each cell in the grid is assigned exactly one of these.
//
// imperviousness  0–1, share of the surface water can't soak into
// vegetation      0–1, vegetation cover
// habitat         0–10, habitat value
// carbon          carbon stored, tonnes C per hectare; relative values
// color           map color
//
// Model parameters (used by models.js, not part of the entity description):
// storage         inches of rain held on site during a storm (soil, ponds, plants)
// barrier         feet a shoreline structure raises the edge above grade
// attenuation     feet of storm surge absorbed per 100 m crossed
// sewered         share of the surface drained by storm sewers
// shade           share of the ground shaded by trees (street trees are added per cell)
// albedo          share of sunlight reflected
// kc              crop coefficient: evapotranspiration relative to a reference lawn

export const CATEGORIES = [
  { id: 'built', name: 'Built' },
  { id: 'transportation', name: 'Transportation' },
  { id: 'open', name: 'Open space' },
  { id: 'water', name: 'Water and wetland' },
];

export const BUILDING_SIZES = {
  low: 'Low-rise (1–4 stories)',
  mid: 'Mid-rise (5–12 stories)',
  high: 'High-rise (13+ stories)',
};

export const USES = { residential: 'Residential', commercial: 'Commercial', industrial: 'Industrial' };

const built = (id, size, use, imperviousness, vegetation, habitat, carbon, color) => ({
  id, category: 'built', name: `${BUILDING_SIZES[size].split(' ')[0]} ${USES[use].toLowerCase()}`,
  size, use, imperviousness, vegetation, habitat, carbon, color, storage: 0, barrier: 0, attenuation: 0, sewered: 1,
});

const t = (id, category, name, imperviousness, vegetation, habitat, carbon, color, extra = {}) => ({
  id, category, name, imperviousness, vegetation, habitat, carbon, color,
  storage: 0, barrier: 0, attenuation: 0, sewered: 0, ...extra,
});

export const ECOSYSTEMS = [
  built('res-low', 'low', 'residential', 0.65, 0.25, 2, 12, '#f6d776'),
  built('res-mid', 'mid', 'residential', 0.80, 0.12, 1, 6, '#eeb04a'),
  built('res-high', 'high', 'residential', 0.85, 0.10, 1, 5, '#d98b26'),
  built('com-low', 'low', 'commercial', 0.90, 0.06, 1, 3, '#f19a9a'),
  built('com-mid', 'mid', 'commercial', 0.92, 0.05, 0.5, 3, '#e05f5f'),
  built('com-high', 'high', 'commercial', 0.95, 0.04, 0.5, 2, '#b8323a'),
  built('ind-low', 'low', 'industrial', 0.95, 0.03, 0.5, 2, '#c7b3d9'),
  built('ind-mid', 'mid', 'industrial', 0.95, 0.03, 0.5, 2, '#9b7fc0'),
  built('ind-high', 'high', 'industrial', 0.96, 0.02, 0.5, 2, '#6f5196'),

  t('street', 'transportation', 'Street', 0.90, 0.10, 1, 4, '#b9b9b9', { sewered: 1 }),
  t('green-street', 'transportation', 'Green street', 0.55, 0.35, 3, 10, '#a3c49a', { storage: 1.5, sewered: 1 }),
  t('highway', 'transportation', 'Highway', 0.95, 0.05, 0.5, 2, '#7d7d7d', { sewered: 1 }),
  t('rail', 'transportation', 'Rail and depot', 0.60, 0.10, 1, 2, '#8c7b6b', { sewered: 0.5 }),
  t('parking', 'transportation', 'Parking lot', 0.95, 0.02, 0, 1, '#d4d0c8', { sewered: 1 }),
  t('port', 'transportation', 'Port and marine terminal', 0.95, 0.02, 0.5, 1, '#8a96a3', { sewered: 1, barrier: 2 }),

  t('plaza', 'open', 'Plaza and playground', 0.70, 0.15, 1, 5, '#e3dcb8', { sewered: 1 }),
  t('park', 'open', 'Park lawn', 0.15, 0.80, 4, 30, '#9fd67f', { storage: 1 }),
  t('garden', 'open', 'Community garden and farm', 0.10, 0.85, 4, 25, '#c3e07a', { storage: 1.2 }),
  t('cemetery', 'open', 'Cemetery', 0.25, 0.70, 5, 45, '#88b97a', { storage: 1 }),
  t('meadow', 'open', 'Meadow', 0.02, 0.95, 7, 40, '#d6e6a0', { storage: 1.5, attenuation: 0.05 }),
  t('forest', 'open', 'Forest', 0.02, 0.98, 9, 110, '#3f8a46', { storage: 2, attenuation: 0.1 }),

  t('water', 'water', 'Open water', 0, 0, 5, 0, '#7fb6dc'),
  t('salt-marsh', 'water', 'Salt marsh', 0, 0.90, 10, 160, '#4fa79a', { storage: 4, attenuation: 0.3 }),
  t('fresh-wetland', 'water', 'Freshwater wetland', 0, 0.90, 9, 120, '#5bb3b0', { storage: 6, attenuation: 0.2 }),
  t('beach', 'water', 'Beach and dune', 0, 0.20, 5, 5, '#f3e6b3', { storage: 1, barrier: 3, attenuation: 0.1 }),
  t('living-shoreline', 'water', 'Living shoreline', 0, 0.40, 8, 40, '#6fbf8e', { storage: 2, barrier: 1, attenuation: 0.5 }),
  t('riprap', 'water', 'Riprap', 0.50, 0.05, 2, 0, '#a59f95', { barrier: 2 }),
  t('bulkhead', 'water', 'Bulkhead and seawall', 1, 0, 0.5, 0, '#5d6670', { barrier: 4 }),
];

// Cooling parameters for the InVEST Urban Cooling model, from typical values
// in its documentation and NYC land cover: [shade, albedo, kc]. Shade on built
// and street types counts only backyards and courtyards, because each cell's
// street trees come from the tree census.
const COOLING = {
  'res-low': [0.15, 0.15, 0.35], 'res-mid': [0.08, 0.15, 0.2], 'res-high': [0.05, 0.18, 0.15],
  'com-low': [0.03, 0.15, 0.1], 'com-mid': [0.03, 0.17, 0.08], 'com-high': [0.02, 0.2, 0.05],
  'ind-low': [0.02, 0.17, 0.08], 'ind-mid': [0.02, 0.17, 0.05], 'ind-high': [0.02, 0.2, 0.05],
  street: [0, 0.1, 0.1], 'green-street': [0.35, 0.15, 0.5], highway: [0, 0.1, 0.05], rail: [0.05, 0.15, 0.3],
  parking: [0, 0.1, 0.03], port: [0, 0.15, 0.03],
  plaza: [0.1, 0.2, 0.2], park: [0.25, 0.2, 0.8], garden: [0.15, 0.2, 0.9], cemetery: [0.3, 0.2, 0.75],
  meadow: [0.05, 0.22, 0.85], forest: [0.9, 0.15, 1],
  water: [0, 0.06, 1], 'salt-marsh': [0, 0.15, 1], 'fresh-wetland': [0.2, 0.15, 1], beach: [0, 0.3, 0.1],
  'living-shoreline': [0.05, 0.15, 0.8], riprap: [0, 0.2, 0.05], bulkhead: [0, 0.15, 0],
};
for (const e of ECOSYSTEMS) [e.shade, e.albedo, e.kc] = COOLING[e.id];

export const TYPE_INDEX = Object.fromEntries(ECOSYSTEMS.map((e, i) => [e.id, i]));
export const typeById = (id) => ECOSYSTEMS[TYPE_INDEX[id]];
export const WATER = TYPE_INDEX.water;
export const isWater = (i) => i === WATER;
