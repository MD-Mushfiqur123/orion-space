# NASA Space Apps Challenge 2026: Submission Copy-Paste Guide

> **Team:** Orion Space · **Local event:** Barisal, Bangladesh
> **Challenge:** *Be An Earth System Trend Detective!*
> **Repository:** https://github.com/MD-Mushfiqur123/orion-space

Every number below comes from `python3 analysis/trend_analysis.py`. If the analysis changes, re-run it and update this file, the README and the pitch deck together.

---

## Field 1: Project title
```text
Orion Space: Earth System Trend Detective
```

## Field 2: Team
- **Team name:** `Orion Space`
- **Members:** list every registered teammate (all must be registered for the Barisal local event).

## Field 3: Challenge
```text
Be An Earth System Trend Detective!
```

## Field 4: High-level summary
```text
Orion Space is a 3D globe that shows how Bangladesh's air temperature is changing, using 25 years (2001-2025) of NASA MERRA-2 data from the NASA POWER API. For each of the 34 MERRA-2 grid cells over Bangladesh we tested every month and the annual mean with the Mann-Kendall test and the Theil-Sen slope, and corrected for multiple testing (Benjamini-Hochberg FDR). The annual mean shows no significant trend anywhere, but September is warming in all 34 cells (31 remain significant after FDR), by +0.40 °C per decade on the Barisal coast (p < 0.001). The app puts this on a CesiumJS globe with live NASA GIBS imagery and FIRMS fires, and a trend agent that flies to a place and shows the evidence.
```

## Field 5: Project details

**What it does.** Answers the challenge's four questions for Bangladesh's 2-metre air temperature:

1. **What is changing?** Late-monsoon air temperature, above all in September.
2. **Where?** All of Bangladesh; fastest robust signal on the Barisal coast (22.5°N, 90.0°E).
3. **How much?** September median +0.36 °C/decade across the 34 cells; +0.40 °C/decade on the Barisal coast (Theil-Sen).
4. **Is it significant?** September: 34 of 34 cells at p < 0.05, 31 of 34 after FDR (q = 0.05). The annual mean: 0 of 34. October warms at a similar rate but no cell survives FDR, so we do not claim it.

**How it works.**
- Data: NASA POWER Monthly API (source MERRA-2), T2M, 2001–2025, 104 grid cells; the 34 with centres inside Bangladesh are analysed.
- Statistics: Mann-Kendall (tie-corrected), Theil-Sen slope, Benjamini-Hochberg FDR over 442 tests. Open, reproducible Python script in `analysis/`.
- App: CesiumJS 3D globe; Climate Detective panel; trend agent with evidence cards; NASA GIBS MODIS/VIIRS true-colour layer; NASA FIRMS fires.

**Why it matters.** Yearly averages are what most people see, and here they say "nothing is happening". A month-by-month view shows a robust late-monsoon warming that matters for the Aman rice season and the run-up to the post-monsoon cyclone season.

**Limits.** Grid cells, not stations; one variable (T2M). Autocorrelation was checked (trend-free pre-whitening) and does not change the results.

**Built on.** The 3D engine and layer system come from the open-source (MIT) project God's Eye View by Bilawal Sidhu. Our team's work is the dataset, the analysis, the Climate Detective panel, the trend agent and the Bangladesh focus.

## Field 6: Space agency data used
1. **NASA MERRA-2 via NASA POWER** (T2M monthly, 2001–2025): https://power.larc.nasa.gov/
2. **NASA GIBS** WMTS, MODIS Terra/Aqua and VIIRS Corrected Reflectance: https://gibs.earthdata.nasa.gov/
3. **NASA FIRMS** active fire detections: https://firms.modaps.eosdis.nasa.gov/

## Field 7: Links
- Repository: https://github.com/MD-Mushfiqur123/orion-space
- Analysis and method: https://github.com/MD-Mushfiqur123/orion-space/tree/main/analysis
- Demo video: *(add link)*
- Live demo: *(add link; run with Node so the `/api` live feeds work)*

## Field 8: Pitch outline
1. Title, team, Barisal.
2. Problem: yearly averages hide seasonal change.
3. Data and method: MERRA-2 via POWER, Mann-Kendall, Theil-Sen, FDR.
4. Finding: September warming everywhere, +0.40 °C/decade on the Barisal coast; annual mean flat.
5. Demo: globe, Climate Detective panel, trend agent.
6. Limits and next steps: more variables (rainfall, humidity).
7. Credits: built on God's Eye View (MIT).
