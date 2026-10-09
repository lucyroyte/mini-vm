// Lot scale: one tax lot and the things its owner can do on it (a green roof,
// a rain tank, a cool roof, solar panels, a rain garden, trees, low-flow
// toilets), with the same rain, heat and water rules the borough models use,
// applied to the lot's own roof, paving and planting in square feet.

import { typeById } from './ecosystems.js';
import { HEAT, POLICY, ROOFS, SOIL_INFILTRATION, annualCapture } from './models.js';

export { annualCapture };

export const GAL_PER_SQFT_IN = 0.6234; // gallons in an inch of rain over a square foot

export const LOT = {
  greenRoofIn: ROOFS.greenRoofIn,
  rainGardenIn: 6, // inches of ponding in a rain garden, on top of what soaks in
  treeCrownSqft: 490, // a young street or yard tree's crown at maturity, 25 ft across
  treeCo2Tonnes: 0.022, // CO₂ a mature tree takes up a year (about 48 lb)
  solarWPerSqft: ROOFS.solarWPerSqft,
  solarKwhPerKw: ROOFS.solarKwhPerKw,
  gridCo2PerKwh: ROOFS.gridCo2PerKwh,
  roof: ROOFS.surface,
  paved: { albedo: 0.1, kc: 0.03 },
};

export const NO_ACTIONS = {
  green: 0, cool: 0, solar: 0, // shares of the roof
  tank: 0, // gallons
  garden: 0, downspouts: false, // square feet of paving made a rain garden, and whether roof water goes to it
  trees: 0,
  toilets: false, gpf: 1.28,
};

export const TANK_SIZES = [
  { value: 0, label: 'None' },
  { value: 55, label: 'Rain barrel (55 gal)' },
  { value: 250, label: 'Large barrels (250 gal)' },
  { value: 1000, label: 'Cistern (1,000 gal)' },
  { value: 5000, label: 'Large cistern (5,000 gal)' },
];

// The lot as it is: its area, roof, and the paved and planted ground around the
// roof. The roof is the larger of its building footprints and PLUTO's floor
// area over floors, since footprints sometimes miss a building on the lot. Planting and tree canopy come from the 2017 aerial land cover of the
// cells the lot covers, since PLUTO doesn't record yards.
export function lotSite(details, world, cells) {
  const lot = details.lotarea || details.shapeSqft || 0;
  const floorplate = details.floors > 0 ? details.bldgarea / details.floors : 0;
  const roof = Math.min(lot, Math.max(details.roofSqft || 0, floorplate));
  const c = world.cells;
  let tree = 0, green = 0, n = 0;
  for (const i of cells) if (c.tree?.[i] >= 0) { tree += c.tree[i]; green += c.tree[i] + c.grass[i]; n++; }
  const open = lot - roof;
  const planted = n ? Math.min(open, (lot * green) / n) : 0;
  return {
    ...details,
    lot, roof, planted, paved: open - planted,
    treeSqft: n ? Math.min(lot, (lot * tree) / n) : 0,
  };
}

// Rain, heat, water and carbon for a lot with a set of actions. `rainfall` is
// one hour of rain in inches; `surfaceF` is the lot's summer surface
// temperature today (its cell's Landsat measurement).
export function lotEffects(site, a, rainfall, surfaceF) {
  const G = GAL_PER_SQFT_IN;
  const garden = typeById('garden');
  const yardIn = garden.storage + SOIL_INFILTRATION; // a planted yard, like a garden cell
  const gardenIn = LOT.rainGardenIn + SOIL_INFILTRATION;
  const greenArea = a.green * site.roof;
  const rainGarden = Math.min(a.garden, site.paved);
  const paved = site.paved - rainGarden;

  // One storm, in gallons. Roof water goes through the green roof, then the
  // tank, then the rain garden if the downspouts lead there, else to the sewer.
  const storm = { rain: rainfall * site.lot * G, greenRoof: 0, tank: 0, garden: 0, soil: 0, sewer: 0 };
  storm.greenRoof = Math.min(rainfall, LOT.greenRoofIn) * greenArea * G;
  let roofOut = rainfall * site.roof * G - storm.greenRoof;
  storm.tank = Math.min(a.tank, roofOut);
  roofOut -= storm.tank;
  const toGarden = rainfall * rainGarden * G + (a.downspouts && rainGarden ? roofOut : 0);
  if (!(a.downspouts && rainGarden)) storm.sewer += roofOut;
  storm.garden = Math.min(toGarden, rainGarden * gardenIn * G);
  storm.sewer += toGarden - storm.garden;
  storm.soil = Math.min(rainfall, yardIn) * site.planted * G;
  storm.sewer += Math.max(0, rainfall - yardIn) * site.planted * G + rainfall * paved * G;

  // A normal year, in gallons, following the same path.
  const Y = POLICY.annualRainIn;
  const year = { rain: Y * site.lot * G, held: 0 };
  const greenHeld = Y * greenArea * G * annualCapture(LOT.greenRoofIn);
  let roofYear = Y * site.roof * G - greenHeld;
  const tankHeld = site.roof > 0 ? roofYear * annualCapture(a.tank / (site.roof * G)) : 0;
  roofYear -= tankHeld;
  const gardenInflow = Y * rainGarden * G + (a.downspouts && rainGarden ? roofYear : 0);
  const gardenHeld = gardenInflow ? gardenInflow * annualCapture((rainGarden * gardenIn * G * Y) / gardenInflow) : 0;
  const soilHeld = Y * site.planted * G * annualCapture(yardIn);
  year.held = greenHeld + tankHeld + gardenHeld + soilHeld;
  year.sewer = year.rain - year.held;

  // Heat: the InVEST cooling capacity (0.6 shade + 0.2 albedo + 0.2
  // evapotranspiration) of each surface, weighted by area, scaled as in the
  // borough model: every 0.1 of cooling capacity is 2.8 °F of surface.
  const r = LOT.roof;
  const darkShare = Math.max(0, 1 - a.green - a.cool - a.solar);
  const roofSurf = (k) => a.green * r.green[k] + a.cool * r.cool[k] + a.solar * r.solar[k] + darkShare * r.dark[k];
  const roofCC = 0.2 * roofSurf('albedo') + 0.2 * roofSurf('kc');
  const ground = (k) => (paved * LOT.paved[k] + (site.planted + rainGarden) * garden[k]);
  const canopy = Math.min(site.lot, site.treeSqft + a.trees * LOT.treeCrownSqft);
  const lotCC = site.lot ? (site.roof * roofCC + 0.2 * ground('albedo') + 0.2 * ground('kc') + 0.6 * canopy) / site.lot : 0;

  const residents = site.residents ?? 0;
  const solarKw = (a.solar * site.roof * LOT.solarWPerSqft) / 1000;
  const solarKwh = solarKw * LOT.solarKwhPerKw;
  return {
    storm, year,
    heat: { lotCC, roofCC, uhiMax: HEAT.uhiMax, surfaceF },
    canopySqft: canopy,
    plantedSqft: site.planted + rainGarden + greenArea,
    solar: { kw: solarKw, kwh: solarKwh, co2: solarKwh * LOT.gridCo2PerKwh },
    treesCo2: a.trees * LOT.treeCo2Tonnes,
    toiletsGalDay: residents * POLICY.flushesPerDay * (a.toilets ? a.gpf : POLICY.toiletGpfToday),
  };
}

// The lot today and with its actions, with temperatures moved by the change in
// cooling capacity from today's surface temperature.
export function compareLot(site, actions, rainfall, surfaceF) {
  const today = lotEffects(site, NO_ACTIONS, rainfall, surfaceF);
  const after = lotEffects(site, actions, rainfall, surfaceF);
  const k = HEAT.uhiMax;
  today.heat.lotF = surfaceF;
  after.heat.lotF = surfaceF - k * (after.heat.lotCC - today.heat.lotCC);
  today.heat.roofDeltaF = 0;
  after.heat.roofDeltaF = -k * (after.heat.roofCC - today.heat.roofCC);
  return { today, after };
}
