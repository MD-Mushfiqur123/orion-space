<div align="center">

# 🛰️ Orion Space: Earth System Trend Detective

[![NASA Space Apps 2026](https://img.shields.io/badge/NASA_Space_Apps-2026-blue.svg?style=for-the-badge)](https://www.spaceappschallenge.org/2026/challenges/be-an-earth-system-trend-detective/)
[![Team](https://img.shields.io/badge/Team-Orion_Space-0284c7?style=for-the-badge)](https://github.com/MD-Mushfiqur123/orion-space)
[![Local Event](https://img.shields.io/badge/Local_Event-Barisal,_Bangladesh-10b981?style=for-the-badge)](https://github.com/MD-Mushfiqur123/orion-space)

**Team Orion Space · Barisal, Bangladesh · NASA Space Apps Challenge 2026**
**Challenge: *Be An Earth System Trend Detective!***

</div>

---

## What we found

We tested 25 years (2001–2025) of NASA **MERRA-2** 2-metre air temperature (T2M), pulled through the **NASA POWER** API, for the 34 MERRA-2 grid cells whose centres fall inside Bangladesh. Each month and the annual mean were tested separately with the **Mann-Kendall** test and the **Theil-Sen** slope, and every p-value was corrected for multiple testing with **Benjamini-Hochberg FDR** (q = 0.05).

| Question | Answer |
|---|---|
| **What** is changing? | Late-monsoon air temperature, above all in **September**. |
| **Where**? | Everywhere in Bangladesh; on the **Barisal coast** (22.5°N, 90.0°E) the September rate is +0.40 °C/decade. |
| **How much**? | September median +0.36 °C/decade across the 34 cells (Theil-Sen). |
| **Is it significant**? | September: significant in **34 of 34** cells at p < 0.05, **31 of 34** after FDR. Barisal coast: Mann-Kendall p = 0.00007. |

The annual mean shows **no significant trend in any cell** (median +0.02 °C/decade). Spring months (Feb–May) lean toward cooling but none of it is significant. October warms at a similar rate to September (median +0.39 °C/decade, 29 of 34 cells at p < 0.05), but **none of those cells survive the FDR correction**, so we do not claim it.

**The point:** a yearly average hides a strong, robust seasonal signal. That is what the 3D globe is built to show.

Every number above is reproducible:

```bash
pip install numpy scipy
python3 analysis/trend_analysis.py
```

Full method and outputs: [`analysis/README.md`](analysis/README.md) and [`analysis/results/`](analysis/results/).

### Limits we are open about
- The 34 points are **MERRA-2 reanalysis grid cells** (about 0.5° × 0.625°), not weather stations.
- 25 annual values per series. Autocorrelation was checked with trend-free pre-whitening: only 9 of 442 series needed it, and the significant results did not change.
- T2M is the only variable analysed so far.

---

## What the app does

- **3D globe (CesiumJS)** with a **Climate Detective** panel that shows the Barisal September trend card.
- **Trend agent** ("AGENT HARNESS" in the dock) answers questions like *"Where is it warming fastest?"* or *"Is it significant?"* by flying to the place and opening an evidence card with the numbers above.
- **NASA GIBS** true-colour imagery (MODIS Terra/Aqua, VIIRS) streamed as a live cloud layer.
- **NASA FIRMS** active fires, plus earthquakes, wind, weather radar and satellite layers in the **Earth Observation** and **Events** groups of the layer panel.
- Extra layers inherited from the base project (aircraft, vessels, traffic, cameras, infrastructure, radio) are still available but start collapsed.
- A short pitch deck lives at `/pitch`.

---

## Quick start

Needs **Node.js 24.14+** (see `engines` in `package.json`). No API keys are required for the core experience.

```bash
git clone https://github.com/MD-Mushfiqur123/orion-space.git
cd orion-space
npm install
npm run dev        # http://localhost:5173/
```

- `npm run build` creates a static build in `dist/`.
- `npm test` runs the unit tests.
- Optional keys (Google Photorealistic 3D Tiles, FIRMS, and others) are described in [`API_KEY_MANUAL.md`](API_KEY_MANUAL.md).

### Deployment note
Live feeds such as flights, vessels, FIRMS and the weather proxies are served by the Node middleware in `server/`, which runs inside the Vite dev server (`npm run dev` / `npm run preview`). A purely static host (for example the current `vercel.json` static build) serves the globe, the GIBS imagery and the bundled climate results, but **not** those `/api` routes. For a full live demo, run the app with Node.

---

## Data sources

| Source | Provider | Used for |
|---|---|---|
| MERRA-2 T2M via NASA POWER Monthly API | NASA GSFC GMAO / NASA LaRC | Trend analysis (`public/data/climate/`) |
| GIBS WMTS (MODIS, VIIRS Corrected Reflectance) | NASA EOSDIS | Live true-colour cloud imagery |
| FIRMS | NASA EOSDIS | Active fire detections |
| Others (USGS earthquakes, NOAA/NHC, OpenSky, CelesTrak, …) | See [`DATA_SOURCES.md`](DATA_SOURCES.md) | Context layers |

The `src/osint/` folder holds experimental modules (GRACE, Sentinel-1/5P, lightning, sea-level) that are **not wired into the running app**; some of them generate simulated values and are marked as such in their file headers.

---

## Built on

Orion Space is built on top of **[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)** by **Bilawal Sidhu**, an open-source (MIT) CesiumJS spatial-intelligence viewer. The 3D globe engine, the layer system, the live-feed server and most of the inherited layers come from that project, and its copyright notice is kept in [`LICENSE`](LICENSE).

**Team Orion Space's own work** for this challenge:
- The MERRA-2 / NASA POWER temperature dataset for Bangladesh and the trend analysis (`analysis/`, `public/data/climate/`).
- The Climate Detective panel, the trend agent (`src/agent/OrionMapHarness.js`) and the Bangladesh focus.
- The NASA GIBS real-cloud layer integration, the UI redesign (Tailwind + shadcn) and the pitch deck (`public/pitch/`).

---

## Team

- **Md Mushfiqur Rahim** ([@MD-Mushfiqur123](https://github.com/MD-Mushfiqur123)), lead developer
- [@nabeulislam](https://github.com/nabeulislam), UI redesign
- **Fahmid Hasan Taohid** ([@fahmidhasann](https://github.com/fahmidhasann)), review and analysis
- *(add the remaining team members here)*

Local event: **Barisal, Bangladesh** · Challenge: **Be An Earth System Trend Detective!**

Licensed under the [MIT License](LICENSE). Third-party data is owned by its providers; see [`DATA_SOURCES.md`](DATA_SOURCES.md).
