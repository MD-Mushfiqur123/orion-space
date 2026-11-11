# Model Card — Orion-0.6B v0.1

## Model Overview

- **Model Identity:** `Orion-0.6B v0.1` (served as `orion-qwen3-0.6b`)
- **Base Model:** `Qwen/Qwen3-0.6B` (not pretrained from scratch)
- **Fine-Tuning Method:** Parameter-Efficient LoRA Supervised Fine-Tuning (SFT)
- **Target Training Hardware:** Kaggle T4 GPU (16 GB VRAM)
- **Role in Orion Space:** Lightweight bilingual (Bangla, Banglish, English) intent & tool-calling planner and grounded summarizer behind the Node.js Agent Backend (`POST /api/orion/agent`).

---

## Intended Use & Architecture Boundary

`Orion-0.6B v0.1` is **not** a standalone general-purpose factual oracle. Inside the Orion Space hybrid architecture:
1. Instant map/camera controls (`orbit`, `clouds`, shaders, coordinates, simple district fly-to) execute directly client-side in `OrionMapHarness.js`.
2. Scientific, weather, agricultural, and multi-district queries hit the Node.js backend, where `Orion-0.6B v0.1` selects from 5 allowlisted tools:
   - `resolve_bangladesh_location`
   - `query_climate_trends`
   - `get_live_weather`
   - `get_active_fires`
   - `get_crop_advisory`
3. All statistical numbers (Sen slopes, Mann-Kendall p-values, Benjamini-Hochberg FDR verdicts) come deterministically from `analysis/results/t2m_trends_by_cell_month.csv` and live weather/fire proxies—never from parametric memory.

---

## Training Data & Provenance

Generated reproducibly via `training/build_dataset.py` and verified by `training/validate_dataset.py`:
- **Climate Ground Truth:** 2001–2025 NASA MERRA-2 2-metre air temperature (`T2M`) pulled via NASA POWER API, analyzed across 34 grid cells inside Bangladesh (442 cell×month tests) using Mann-Kendall, Theil-Sen slope, Benjamini-Hochberg FDR (`q = 0.05`), and trend-free pre-whitening (`analysis/trend_analysis.py`).
- **District Registry:** 64 Bangladesh districts + coastal sectors (`src/agent/bangladeshDistricts.js`) with English, Banglish, and Bangla aliases.
- **Leak-Free Evaluation Splits:**
  - `val` held-out districts: `patuakhali`, `bogra`, `rangamati`, `habiganj`
  - `test` held-out districts: `pirojpur`, `dinajpur`, `coxsbazar`, `sunamganj`
  - Plus unseen phrasings for global significance, October FDR trap, annual mean trap, and `unavailable` live-feed honesty checks.
- **Git-tracked Reviewed Sample:** `training/examples/reviewed_examples.jsonl` (18 representative examples). Full model checkpoints and generated training weights are **never** committed to GitHub.

---

## Evaluation Metrics (Measured on Held-Out `test` Set)

Run `training/evaluate.py --compare-base --adapter-dir ...` after Kaggle training to record:
- First-turn allowlisted tool selection accuracy
- Tool argument accuracy (`mode`, `districtId`, `month`)
- Grounded numeric fidelity against tool outputs
- Scientific trap pass rate:
  - Must report October warming (`29/34` at `p < 0.05`) has **`0/34` surviving BH FDR (`q = 0.05`)**
  - Must report Annual mean (`0/34` significant) masks seasonal warming
  - Must explicitly state `unavailable` without inventing telemetry when a live tool reports `status: "unavailable"`

---

## Known Limitations & Fallback Policy

- At `0.6B` parameters, complex multi-hop reasoning or nuanced Bangla prose can still fail on edge cases. The Node.js orchestrator (`server/agent/orchestrator.js`) therefore validates every `evidenceCard` and `mapActions` deterministically from tool outputs and falls back automatically to deterministic grounded planning on timeout, invalid JSON, or inference outage.
- The 34 climate points represent MERRA-2 reanalysis grid cells (~0.5° × 0.625°), not point weather stations.

---

## Licensing & Attribution

- **Base Model (`Qwen/Qwen3-0.6B`):** Apache License 2.0 (see Qwen3 upstream repository for full attribution and notices).
- **Orion Space Training Code & Adapters:** MIT License (`LICENSE`).
- **Scientific Datasets:** NASA POWER / MERRA-2, Open-Meteo, and NASA FIRMS (see `DATA_SOURCES.md`).
