#!/usr/bin/env python3
"""
Reproducible trend analysis for Orion Space (NASA Space Apps 2026,
"Be An Earth System Trend Detective!").

Input : public/data/climate/bangladesh_t2m_regional_raw.json
        (NASA POWER Monthly & Annual API v2.10, source MERRA-2, T2M in deg C,
         2001-2025, 104 native MERRA-2 grid cells over Bangladesh)
Output: analysis/output/t2m_trends_by_cell_month.csv  (one row per cell x month + annual)
        analysis/output/summary.md

Methods
- Mann-Kendall test with tie-corrected variance (two-sided).
- Theil-Sen slope (median of pairwise slopes), reported per decade.
- Benjamini-Hochberg false discovery rate (q = 0.05) across all tests
  inside Bangladesh, because many cells x months are tested at once.

Note: the points are MERRA-2 reanalysis grid cells (~0.5 x 0.625 deg),
not weather stations. Lag-1 autocorrelation is not corrected here.

Usage: python3 analysis/trend_analysis.py   (needs numpy + scipy)
"""
import csv, json, math, os
from itertools import combinations
import numpy as np
from scipy.stats import norm

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "public/data/climate/bangladesh_t2m_regional_raw.json")
BOUNDARY = os.path.join(ROOT, "public/data/climate/bangladesh_boundary.geojson")
OUT = os.path.join(ROOT, "analysis/output")
MONTHS = ["January","February","March","April","May","June","July",
          "August","September","October","November","December","Annual"]

def mann_kendall(x):
    x = np.asarray(x, float); n = len(x)
    s = sum(np.sign(x[j] - x[i]) for i, j in combinations(range(n), 2))
    _, counts = np.unique(x, return_counts=True)
    var = (n*(n-1)*(2*n+5) - sum(t*(t-1)*(2*t+5) for t in counts)) / 18.0
    z = (s - 1)/math.sqrt(var) if s > 0 else (s + 1)/math.sqrt(var) if s < 0 else 0.0
    return s, z, 2*(1 - norm.cdf(abs(z)))

def sen_slope(x):
    x = np.asarray(x, float)
    return float(np.median([(x[j]-x[i])/(j-i) for i, j in combinations(range(len(x)), 2)]))

def _in_ring(lon, lat, ring):
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1)*(lat - y1)/(y2 - y1) + x1:
            inside = not inside
    return inside

def load_boundary():
    g = json.load(open(BOUNDARY)); polys = []
    for f in g["features"]:
        geom = f["geometry"]
        polys += [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    return polys

def inside_bangladesh(lon, lat, polys):
    return any(_in_ring(lon, lat, [tuple(c[:2]) for c in poly[0]]) and
               not any(_in_ring(lon, lat, [tuple(c[:2]) for c in h]) for h in poly[1:])
               for poly in polys)

def bh_fdr(p, q=0.05):
    p = np.asarray(p); m = len(p); order = np.argsort(p)
    passed = p[order] <= q*np.arange(1, m+1)/m
    k = np.max(np.where(passed)[0]) + 1 if passed.any() else 0
    sig = np.zeros(m, bool); sig[order[:k]] = True
    return sig

def main():
    raw = json.load(open(RAW)); fill = raw["header"].get("fill_value", -999.0)
    polys = load_boundary()
    rows = []
    for f in raw["features"]:
        lon, lat = f["geometry"]["coordinates"][:2]
        t2m = f["properties"]["parameter"]["T2M"]
        years = sorted({k[:4] for k in t2m})
        for mi, name in enumerate(MONTHS, start=1):
            series = [t2m.get(f"{y}{mi:02d}", fill) for y in years]
            if any(v == fill for v in series):
                continue
            s, z, p = mann_kendall(series)
            rows.append(dict(latitude=lat, longitude=lon,
                             inside_bangladesh=inside_bangladesh(lon, lat, polys), month=name, n_years=len(series),
                             mk_S=int(s), mk_Z=round(z, 4), p_value=round(p, 6),
                             sen_slope_c_per_decade=round(10*sen_slope(series), 4)))
    # FDR family: every test whose cell centre is inside Bangladesh
    # (34 cells x 13 series). Cells outside are corrected as their own family.
    for flag in (True, False):
        fam = [r for r in rows if r["inside_bangladesh"] == flag]
        for r, sig in zip(fam, bh_fdr([r["p_value"] for r in fam])):
            r["significant_p05"] = r["p_value"] < 0.05
            r["significant_fdr05"] = bool(sig)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "t2m_trends_by_cell_month.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    bd = [r for r in rows if r["inside_bangladesh"]]
    annual = [r for r in bd if r["month"] == "Annual"]
    top = sorted((r for r in bd if r["month"] != "Annual"), key=lambda r: -r["sen_slope_c_per_decade"])[:5]
    mrows = []
    lines = ["# T2M trend summary (MERRA-2 via NASA POWER, 2001-2025)", "",
             f"- Grid cells in the file: {len(rows)//len(MONTHS)}; cells whose centre lies inside Bangladesh: {len(annual)}",
             f"- Tests inside Bangladesh (34 cells x 12 months + annual): {len(bd)}; FDR family = these tests",
             f"- Inside Bangladesh, significant at p<0.05: {sum(r['significant_p05'] for r in bd)} of {len(bd)}",
             f"- Inside Bangladesh, significant after Benjamini-Hochberg FDR (q=0.05): {sum(r['significant_fdr05'] for r in bd)} of {len(bd)}",
             f"- Annual-mean cells with significant warming (p<0.05): {sum(r['significant_p05'] and r['sen_slope_c_per_decade']>0 for r in annual)} of {len(annual)}",
             "", "## Fastest monthly warming inside Bangladesh (Theil-Sen)", "",
             "| Lat | Lon | Month | Sen slope (°C/decade) | p | FDR-significant |", "|---|---|---|---|---|---|"]
    for m in MONTHS:
        mm = [r for r in bd if r["month"] == m]
        med = float(np.median([r["sen_slope_c_per_decade"] for r in mm]))
        mrows.append(f"| {m} | {med:+.3f} | {sum(r['significant_p05'] and r['sen_slope_c_per_decade']>0 for r in mm)} of {len(mm)} | {sum(r['significant_fdr05'] and r['sen_slope_c_per_decade']>0 for r in mm)} of {len(mm)} |")
    lines += [f"| {r['latitude']} | {r['longitude']} | {r['month']} | {r['sen_slope_c_per_decade']:+.3f} | {r['p_value']:.4f} | {'yes' if r['significant_fdr05'] else 'no'} |" for r in top]
    lines += ["", "## By month, cells inside Bangladesh", "",
              "| Month | Median Sen slope (°C/decade) | Warming, p<0.05 | Warming, FDR q<0.05 |", "|---|---|---|---|"] + mrows
    open(os.path.join(OUT, "summary.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))

if __name__ == "__main__":
    main()
