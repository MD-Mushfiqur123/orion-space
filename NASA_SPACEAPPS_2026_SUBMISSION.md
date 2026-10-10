# Orion Space: Earth System Trend Detective
### NASA Space Apps Challenge 2026 · Team Orion Space · Barisal, Bangladesh

**Challenge:** *Be An Earth System Trend Detective!*
**Repository:** https://github.com/MD-Mushfiqur123/orion-space

---

## 1. Summary

Most climate summaries for Bangladesh show yearly averages. In 25 years of NASA MERRA-2 data, the yearly average of 2-metre air temperature shows **no significant trend in any of the 34 grid cells** over the country. Split by month, a different picture appears: **September is warming in all 34 cells**, and 31 of them stay significant after correcting for multiple testing. On the **Barisal coast** the September rate is **+0.40 °C per decade** (Mann-Kendall p = 0.00007).

Orion Space puts that result on a 3D globe, next to live NASA satellite imagery, and lets a user ask *what, where, how much* and *is it significant* in plain language.

---

## 2. Data

| Dataset | Provider | Details |
|---|---|---|
| MERRA-2 T2M (2-metre air temperature) | NASA GSFC GMAO, via the NASA POWER Monthly & Annual API v2.10 (NASA LaRC) | Monthly means and annual mean, 2001–2025, 104 native grid cells (~0.5° × 0.625°); 34 have their centre inside Bangladesh |
| GIBS WMTS, MODIS Terra/Aqua and VIIRS Corrected Reflectance | NASA EOSDIS | Live true-colour imagery layer on the globe |
| FIRMS active fires | NASA EOSDIS | Event layer on the globe |

Raw file: `public/data/climate/bangladesh_t2m_regional_raw.json` · Boundary: `public/data/climate/bangladesh_boundary.geojson`

---

## 3. Method

For each of the 34 cells, 13 series of 25 values (12 calendar months plus the annual mean):

1. **Mann-Kendall test** (two-sided) for a monotonic trend:
   $$S = \sum_{k=1}^{n-1}\sum_{j=k+1}^{n} \operatorname{sgn}(x_j - x_k),\qquad \operatorname{Var}(S) = \frac{n(n-1)(2n+5) - \sum_i t_i(t_i-1)(2t_i+5)}{18}$$
   $$Z = \frac{S - \operatorname{sgn}(S)}{\sqrt{\operatorname{Var}(S)}},\qquad p = 2\,(1 - \Phi(|Z|))$$
2. **Theil-Sen slope**, the median of all pairwise slopes, reported in °C per decade:
   $$Q = \operatorname{median}\left\{\frac{x_j - x_k}{j - k}\right\}$$
3. **Benjamini-Hochberg false discovery rate** at q = 0.05 across all 442 tests (34 × 13), because testing many series at once produces false positives at plain p < 0.05.
4. **Autocorrelation check**: trend-free pre-whitening (Yue et al. 2002) where the lag-1 autocorrelation is significant; the FDR results are unchanged.

Code: [`analysis/trend_analysis.py`](analysis/trend_analysis.py). Run `python3 analysis/trend_analysis.py` to reproduce every number in this document.

---

## 4. Results

### 4.1 The four questions

| Question | Answer |
|---|---|
| What is changing? | Late-monsoon air temperature, above all September |
| Where? | All of Bangladesh; Barisal coast (22.5°N, 90.0°E) is the reference cell |
| How much? | September median +0.36 °C/decade (34 cells); Barisal coast +0.40 °C/decade |
| Significant? | September: 34/34 cells p < 0.05, 31/34 after FDR. Annual mean: 0/34 |

### 4.2 By month, 34 cells inside Bangladesh

| Month | Median Sen slope (°C/decade) | Warming, p < 0.05 | Warming, after FDR |
|---|---|---|---|
| January | +0.167 | 0 | 0 |
| February | −0.250 | 0 | 0 |
| March | −0.280 | 0 | 0 |
| April | −0.107 | 0 | 0 |
| May | −0.477 | 0 | 0 |
| June | −0.022 | 0 | 0 |
| July | +0.151 | 13 | 3 |
| August | +0.038 | 3 | 2 |
| **September** | **+0.360** | **34** | **31** |
| October | +0.389 | 29 | 0 |
| November | +0.233 | 5 | 0 |
| December | +0.084 | 0 | 0 |
| Annual mean | +0.021 | 0 | 0 |

### 4.3 Barisal coast cell (22.5°N, 90.0°E)

| Series | Sen slope (°C/decade) | Mann-Kendall p | After FDR |
|---|---|---|---|
| September | +0.400 | 0.00007 | significant |
| October | +0.435 | 0.019 | not significant |
| Annual mean | −0.021 | 0.89 | not significant |

---

## 5. Why it matters

September closes the monsoon in Bangladesh. It overlaps the growing season of Aman rice and leads into the post-monsoon cyclone season in the Bay of Bengal. A robust late-monsoon warming that the yearly average hides is exactly the kind of change the challenge asks teams to detect. We report the air-temperature trend only; we do not claim effects on cyclones or crops that this data cannot show.

---

## 6. The application

- **CesiumJS 3D globe** with a **Climate Detective** panel (the Barisal September card) and a **trend agent** that flies to a place and opens an evidence card with the numbers above.
- **NASA GIBS** true-colour MODIS/VIIRS imagery, **NASA FIRMS** fires, and weather, wind and earthquake layers grouped under *Earth Observation* and *Events*.
- Pitch deck at `/pitch`.

---

## 7. Limits and next steps

- Points are MERRA-2 reanalysis grid cells, not weather stations.
- Lag-1 autocorrelation checked with trend-free pre-whitening (Yue et al. 2002): 9 of 442 series pre-whitened, FDR results unchanged.
- Only T2M so far; next: precipitation (PRECTOTCORR) and humidity from the same API, and GPM IMERG rainfall.
- Live feeds served by `server/` need the Node server; a static host shows the globe, GIBS imagery and the climate results.

---

## 8. Credits

Built on **[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)** by Bilawal Sidhu (MIT License): the 3D engine, the layer system, the live-feed server and most inherited layers. Team Orion Space added the MERRA-2 dataset and analysis, the Climate Detective panel, the trend agent, the NASA GIBS cloud layer, the UI redesign and the pitch deck.

Licensed under MIT. Third-party data belongs to its providers; see `DATA_SOURCES.md`.
