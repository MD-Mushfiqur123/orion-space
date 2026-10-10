# Trend analysis (reproducible)

`trend_analysis.py` recomputes every statistic quoted in the README, the app and the pitch deck.

## Data
- `public/data/climate/bangladesh_t2m_regional_raw.json`: NASA POWER Monthly & Annual API v2.10, source **MERRA-2**, parameter **T2M** (2-metre air temperature, °C), 2001–2025, 104 native grid cells covering Bangladesh and its borders.
- `public/data/climate/bangladesh_boundary.geojson`: country outline, used to keep the 34 cells whose centre lies inside Bangladesh.

## Method
1. For each cell, build 13 series of 25 values: one per calendar month, plus the annual mean.
2. **Mann-Kendall** test (two-sided, tie-corrected variance) for a monotonic trend.
3. **Theil-Sen** slope (median of pairwise slopes), reported in °C per decade.
4. **Benjamini-Hochberg FDR** at q = 0.05 across all 442 tests inside Bangladesh (34 cells × 13 series).
5. **Autocorrelation check:** trend-free pre-whitening (Yue et al. 2002). Only 9 of 442 series show significant lag-1 autocorrelation, and the FDR results are unchanged after pre-whitening (36 of 442 either way; September still 31 of 34).

Not done (yet): other variables (precipitation, humidity).

## Run
```bash
pip install numpy scipy
python3 analysis/trend_analysis.py
```

## Outputs
- `results/t2m_trends_by_cell_month.csv`: one row per cell × series, with `inside_bangladesh`, `mk_S`, `mk_Z`, `p_value`, `sen_slope_c_per_decade`, `lag1_r`, `prewhitened`, `p_value_tfpw`, `significant_p05`, `significant_fdr05`, `significant_fdr05_tfpw`.
- `results/summary.md`: headline counts and a by-month table.

Note: the older CSVs in `public/data/climate/` (used by the app's map layer) report an OLS slope and its p-value next to the Sen slope. The numbers quoted in the README come from this script.
