<!--
Markdown file of semantic model
Lucy and Jay
-->

# Brooklyn Vision

Create a single-page web application, based on the web mapping tool visionmaker.nyc, that lets users reimagine the landscape of Brooklyn. Users start from a map of Brooklyn as it exists today, built from real data, and change the ecosystem type of any area: buildings, transportation, parks, forests, wetlands, water, and shoreline. The application then runs a set of simple climate models and gives the borough a climate score, showing how the user's changes affect flooding, biodiversity, heat, and carbon compared to today.

## Application requirements

- Make this project a simple single-page web application.
- Use vanilla javascript.
- The primary view should be a 2D map of Brooklyn, using MapLibre GL JS or Leaflet, that fills the browser window.
- A toolbar holds the editing tools, and a side panel shows the climate score and its individual metrics.
- Load real data for Brooklyn from NYC Open Data, including the borough boundary, land cover, building footprints, parks properties, hydrography, shoreline, and the NYC Stormwater Flood Maps or FEMA flood zones.

## Context

The application should represent the following entities:

1. Borough
2. Cell
3. Ecosystem type
4. Vision
5. Climate scenario
6. Climate score

The borough is divided into a grid of cells, each 50 meters on a side. Every cell is assigned one ecosystem type, based on the dominant land cover in the real data. A vision is the set of changes a user makes to these cells. The climate models compare a vision against the existing borough.

## Entity attributes

Describe each entity with the following parameters:

- Borough
    - name: Brooklyn
    - boundary (polygon)
    - total area
- Cell
    - boundary (a square polygon)
    - area (10,000 square meters)
    - elevation (average, in feet)
    - in floodplain: yes/no
    - on shoreline: yes/no
    - existing ecosystem type
    - current ecosystem type
- Ecosystem type
    - category: built, transportation, open space, water and wetland
    - name (see the ecosystem type list below)
    - imperviousness (0 to 1, the share of the surface water can't soak into)
    - vegetation cover (0 to 1)
    - habitat value (0 to 10)
    - carbon stored (relative value per cell)
    - color on the map
- Built ecosystem types also have
    - building size: low-rise (1 to 4 stories), mid-rise (5 to 12 stories), high-rise (13 or more stories)
    - use: residential, commercial, industrial
- Vision
    - name
    - list of changed cells
    - date created
    - policies it adopts (see Policy)
- Policy
    - low-flow toilets: on/off, gallons per flush required
    - rainwater capture: on/off, buildings taller than a number of floors, inches of rain each roof tank holds, new construction only or existing buildings too
- Climate scenario
    - rainfall intensity (inches per hour)
    - sea level rise
