# Brooklyn Vision

A single-page web app, inspired by [visionmaker.nyc](https://visionmaker.nyc), for reimagining the landscape of Brooklyn. Start from a map of Brooklyn as it is today, built from NYC Open Data. Repaint any part of the borough as buildings, streets, parks, forests, wetlands, water or shoreline. Simple climate models then score your vision on flooding, biodiversity, heat and carbon, compared with today.

The semantic model this app implements is in [docs/semantic-model.md](docs/semantic-model.md).

## Running it

It is plain HTML, CSS and vanilla JavaScript (ES modules) with no build step. Serve the folder over HTTP, because browsers won't load modules from `file://`:

```sh
npx http-server -c-1 .   # or: python3 -m http.server
```

Then open http://localhost:8080 (or :8000 for Python).

The first load downloads Brooklyn's data from NYC Open Data, which takes about a minute. The processed grid is then cached in the browser (IndexedDB) for 30 days. To fetch fresh data, use **Borough → Data sources → Reload data**.

## Using it

- **Toolbar**
  - **Inspect**: pan the map and click a cell to see its attributes.
  - **Brush**: paint cells with the chosen ecosystem type. Brush widths are 50, 150, 250, 450 or 850 m.
  - **Rectangle**: drag to fill a rectangle.
  - **Lot**: click a tax lot to paint every cell whose center is inside it. A lot smaller than a cell paints the cell it sits in. Lot shapes come from the city's Digital Tax Map (*TAX_LOT_POLYGON*), one lot at a time as the pointer moves.
  - **Fill**: click to repaint a connected area of one type.
  - **Restore**: paint cells back to their existing type.
  - The type button opens the palette of 28 ecosystem types, grouped by category.
  - **Undo** and **Redo** are also on Ctrl+Z and Ctrl+Shift+Z.
  - **Show** switches the map between the vision, today, changes only, and the model results (flood depth, heat, habitat), plus elevation and the trees and paving measured from the air.
  - **Layers** toggles the reference data and the cell opacity.
  - **3D** tilts the map and shows 3D buildings, so far for Downtown Brooklyn (Community District 2) only. Right-drag or Ctrl-drag to rotate. Painting still works while tilted.
- **Side panel**
  - The overall climate score for the vision against today, and the four metric scores. On each bar, a tick marks today's value.
  - **People**: residents, residents flooded, residents in heat islands (and how many in heat-vulnerable ZIP codes), and the summer surface temperature where people live, with the change from today. These aren't part of the score.
  - The climate scenario: rainfall intensity and sea level rise.
  - Vision management: name, save to the browser, export and import as JSON.
  - The selected cell's attributes, and facts and data sources for the borough.

Keyboard shortcuts: I, B, R, F and E pick the tools; Esc closes the palette.

## Data

| Layer | Source | Used for |
| --- | --- | --- |
| Borough boundary | NYC Open Data, *Borough Boundaries* | Borough polygon, total area, land vs. water cells |
| Land use and buildings | NYC Open Data, *PLUTO* (tax lots: land use, floors, lot and building area) | Built and transportation types, building size and use |
| Parks properties | NYC Open Data, *Parks Properties* | Parks, forests, gardens, cemeteries, plazas, marsh |
| Hydrography | NYC Open Data, *Hydrography* | Inland water |
| Shoreline | NYC Open Data, *Shoreline* | *On shoreline* flag |
| FEMA floodplain | NYC Open Data, *Sea Level Rise Maps (2020s 100-year Floodplain)* (falls back to the *NYC Stormwater Flood Maps*) | *In floodplain* flag |
| Building footprints | NYC Open Data, *Building Footprints* | Drawn on the map at zoom 15+, for the current view only |
| 3D buildings | NYC Planning, *NYC 3D Model by Community District* (Rhino files, 2014 aerial survey) | The **3D** view; Community District 2 only so far |
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (USGS 3DEP lidar) | Average cell elevation in feet |
| Residents | US Census Bureau, *2020 Census Redistricting Data (PL 94-171)*, block population, in `data/census/` | Residents per cell, placed on homes using PLUTO's residential units |
| Summer surface temperature | USGS *Landsat 8/9 Collection 2 surface temperature*, four clear summer days 2023–2025, in `data/heat/` | Today's heat map; the heat model adds a vision's changes to it |
| Stormwater flooding | NYC Open Data, *NYC Stormwater Flood Maps* (moderate and extreme storms), in `data/flood/` | Today's stormwater flooding |
| FloodNet sensors | [FloodNet](https://www.floodnet.nyc/) API (sensor locations) and NYC Open Data, *FloodNet: Street Flooding Events* | **FloodNet flood sensors** layer, loaded when turned on |
| Street trees | NYC Open Data, *2015 Street Tree Census* | Tree shade per cell, for the heat model |
| Heat vulnerability | NYC Open Data, *Heat Vulnerability Index Rankings* (DOHMH, by ZIP code) | Counting heat-vulnerable residents |
| Measured land cover | NYC Open Data, [*Land Cover Raster Data (2017), 6in Resolution*](https://data.cityofnewyork.us/d/he6d-2qns) (2017 lidar and 2016 aerial imagery), reduced to a 12 m map in `data/landcover/` | Each cell's share of tree canopy, grass and paved or roofed surface; corrects open space types; today's imperviousness and vegetation in the models |

NYC Open Data sometimes republishes a dataset under a new ID. `js/data.js` lists the known IDs for each layer, and falls back to a catalog search by name when none of them works. Each layer except the boundary is optional. If one fails to load, the grid is built from the rest, and the failure appears under *Data sources*.

**About land cover.** Each cell's type comes from the vector layers above, checked against what the ground looks like from the air. NYC's *Land Cover 2017* raster (6-inch pixels, 98 GB unzipped) is too large for a browser, so `tools/nyc_landcover.py` reduces it once to a 12 m map of Brooklyn's tree canopy, grass and shrub, and paved or roofed shares (4 MB PNG). The vector layers are sampled on a 25 m lattice (4 points per cell), then:

1. A cell that is mostly outside the borough's land, or mostly inside hydrography, is **open water**.
2. A cell that is mostly park is mapped by the park's category. For example, *Nature Area* becomes forest, *Garden* becomes community garden, and *Playground* becomes plaza. Natural areas below 6 ft in the floodplain become salt marsh.
3. Otherwise, the tax lots in the cell decide. Large lots are spread over the cells they cover. The land use with the most lot area sets the use, and the average floors of its buildings set the size: low-rise is 1–4 stories, mid-rise 5–12, high-rise 13 or more.
4. A cell less than a quarter covered by lots is mostly right-of-way, so it becomes a **street**.
5. Open space is corrected by the measured cover. A park, meadow or vacant lot cell that is 60% or more tree canopy is **forest**. One that is 70% or more paved is **plaza** (a park's courts and playgrounds) or **parking** (a paved vacant lot). A forest cell that is 70% paved is plaza, and one under 25% canopy with more grass than trees is meadow. This turns about 1,150 park cells into forest (Prospect Park's woods, for example), about 1,350 into plaza (playgrounds, courts and paved park paths), about 400 vacant lot cells into parking, and about 110 forest cells into meadow.

Every cell also keeps its measured shares, shown in the cell inspector and in **Show → Trees and paving**. The models use them for today's imperviousness and vegetation, so a tree-lined block of row houses absorbs more rain and runs cooler than a bare one. A cell a vision changes takes its new type's typical values.

The data has no shoreline structure types such as bulkheads, so shoreline cells start as their land type, and visions can add bulkheads, riprap, beaches or living shorelines.

## Model

The entities from the semantic model live in these files:

| Entity | Where |
| --- | --- |
| Borough | `world.borough` in `js/grid.js` (name, boundary, total area) |
| Cell | `world.cells` in `js/grid.js`, stored as typed arrays: boundary from `cellBoundary()`, 2,500 m² area, elevation, in floodplain, on shoreline, existing type, residents, heat vulnerability, street tree shade, measured summer surface temperature. The current type is in the vision. |
| Ecosystem type | `js/ecosystems.js`: category, name, imperviousness, vegetation cover, habitat value, carbon, color, plus building size and use for built types |
| Vision | `js/vision.js`: name, list of changed cells, date created |
| Climate scenario | `state.scenario` in `js/main.js`: rainfall intensity (in/hr) and sea level rise (ft) |
| Climate score | `runModels()` in `js/models.js`: overall score and four metrics |

### Ecosystem types

| Category | Types |
| --- | --- |
| Built | Low-, mid- and high-rise residential, commercial and industrial (9 types) |
| Transportation | Street, green street, highway, rail and depot, parking lot, port and marine terminal |
| Open space | Plaza and playground, park lawn, community garden and farm, cemetery, meadow, forest |
| Water and wetland | Open water, salt marsh, freshwater wetland, beach and dune, living shoreline, riprap, bulkhead and seawall |

### Climate models

All four models are deliberately simple and run in tens of milliseconds, so the score updates while you paint. They are for comparing visions, not for predicting real outcomes.

How the flood and heat models compare with open measurements of Brooklyn (cells with their centers inside each map):

| Model | Compared with | Agreement |
| --- | --- | --- |
| Coastal flooding, 10 ft storm tide | FEMA/NPCC 100-year floodplain (2020s) | 76% of the floodplain flooded; 25% of modeled flooding outside it |
| Coastal flooding, 11.3 ft (Sandy's peak at the Battery) | *Sandy Inundation Zone* | 84% of the zone flooded; 30% outside it |
| Stormwater, 2.13 in/hr | [FloodNet](https://www.floodnet.nyc/) street flood sensors in Brooklyn (135), floods since 2020 | 55% of sensors in cells the model floods have measured 4 in or more of water, against 28% elsewhere. The model flags 65% of the sensors that flooded; the earlier terrain-only model flagged 20% |
| Heat | Landsat summer surface temperature | r = 0.70 |

- **Flooding** has two parts.
  - *Coastal*: a 100-year storm tide (10 ft NAVD88, plus sea level rise) spreads inland from open water across every cell lower than the water. A bulkhead, riprap, port edge or dune stops the water until it is overtopped. Wetlands and living shorelines absorb part of the surge as it crosses them.
  - *Stormwater*: a one-hour storm at the chosen intensity. Today's flooding comes from NYC's *Stormwater Flood Maps*, which the city made with its sewer and surface model, for a moderate (2.13 in/hr) and an extreme (3.66 in/hr) storm. Other intensities are interpolated between them, from no flooding at 1.5 in/hr. Each cell keeps the share of it that floods and how deep. A vision changes the runoff: each cell absorbs rain through its own storage, its pervious soil, and its storm sewers (1.75 in/hr on impervious surfaces), and the excess runs downhill. Each flooded spot's extent and depth scale with the square root of the change in runoff reaching it, so green streets and wetlands uphill shrink it, and paving makes it worse.
  - The score counts flooded homes, businesses and streets (flooded wetlands and parks count only a little). Residents flooded are shown under **People**, outside the score.
- **Residents**: each 2020 Census block's population is split among its tax lots by residential units (blocks with no units, such as dorms and nursing homes, by floor area), then spread over the lots' cells. Where a vision changes a cell's type, the cell gets today's average residents for that type (about 55 per cell for low-rise housing and 150 for mid- and high-rise; commercial and industrial cells hold a few, and parks, nature, streets and water none), so new housing adds people and replacing homes with a park or marsh moves them out.
- **Biodiversity**: each cell's habitat value is weighted by how many of its neighbors are good habitat, which rewards connected habitat. A bonus is added for the number of different habitat types.
- **Heat**: the [InVEST Urban Cooling model](https://storage.googleapis.com/releases.naturalcapitalproject.org/invest-userguide/latest/en/urban_cooling_model.html) from the Natural Capital Project. Each cell's cooling capacity is 0.6 × shade + 0.2 × albedo + 0.2 × evapotranspiration, with shade from the measured tree canopy (or, where a vision changes the cell, its type plus its street trees). Parks of 2 ha or more cool cells within 450 m, and air mixes over about 500 m. Today's map is Landsat's measured summer surface temperature, and a vision adds the model's change from today. The model is scaled to Landsat: measured ≈ 79 °F + 28.4 °F × (1 − heat mitigation), which explains about half the variation between cells (r = 0.70; with street trees alone instead of measured canopy r = 0.57, and the previous model reached r = 0.53). The score is the land's average temperature; heat islands are cells at 105 °F or more. Residents in heat islands, and the temperature where people live, are shown under **People**, outside the score.
- **Carbon**: total carbon stored in soil and plants, in tonnes per 1-ha cell.

Each metric is scored from 0 to 100, and the climate score is their average.

## Files

```
index.html           page layout
css/style.css        styles
js/main.js           loading, tools, and app wiring
js/data.js           NYC Open Data (Socrata) loading
js/elevation.js      terrain tiles → elevation
js/rasters.js        summer surface temperature and stormwater flood maps
js/landcover.js      measured land cover map (data/landcover/)
js/geo.js            projection and polygon rasterization
js/grid.js           Borough and Cell grid, land cover classification
js/ecosystems.js     ecosystem types
js/models.js         climate models and score
js/vision.js         Vision: edits, undo, save
js/map.js            MapLibre map and layers
js/ui.js             side panel, palette, legend
js/store.js          IndexedDB cache
js/model3d.js        3D buildings: three.js layer on the map
data/3d/             3D buildings per community district (glTF) and models.json listing them
data/census/         2020 Census population and housing units per Brooklyn block
data/heat/           Landsat summer surface temperature (PNG) and its bounds
data/flood/          NYC Stormwater Flood Maps for Brooklyn (PNG) and their bounds
data/landcover/      tree canopy, grass and paved shares at 12 m, from NYC Land Cover 2017
tools/               converter from the NYC 3D Model (.3dm) to glTF, and the census, Landsat, flood map and land cover extractors
docs/semantic-model.md
```
