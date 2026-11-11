#!/usr/bin/env python3
"""
Build reproducible, leak-free train / val / test JSONL splits for Orion-0.6B v0.1
(Qwen/Qwen3-0.6B LoRA SFT) grounded strictly in:
  - analysis/results/t2m_trends_by_cell_month.csv
  - src/agent/bangladeshDistricts.js
  - server/agent/toolRegistry.js (5 allowlisted tools)

Generates:
  - training/artifacts/train.jsonl
  - training/artifacts/val.jsonl
  - training/artifacts/test.jsonl
  - training/examples/reviewed_examples.jsonl (small curated git-tracked sample)
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CSV = ROOT / "analysis" / "results" / "t2m_trends_by_cell_month.csv"
DEFAULT_CONFIG = Path(__file__).resolve().parent / "orion_qwen3_config.json"

SYSTEM_PROMPT = "\n".join(
    [
        "You are Orion Intelligence Agent (Orion-0.6B v0.1) for Bangladesh Earth System Trend Detective.",
        "Always call the allowlisted tools before answering climate, weather, fire, crop, or district questions.",
        "NEVER invent temperature trends, Sen slopes, p-values, FDR counts, weather metrics, or fire detections.",
        "Key verified baseline facts from NASA MERRA-2 (2001-2025, 34 cells in Bangladesh):",
        "- Annual mean has 0 of 34 significant cells (median +0.021 C/decade).",
        "- September warms significantly in 34 of 34 cells at p<0.05 and 31 of 34 after Benjamini-Hochberg FDR (q=0.05); Barisal coast (22.5N, 90.0E) is +0.40 C/decade (p=0.00007).",
        "- October shows 29 of 34 cells at p<0.05 (median +0.389 C/decade) but 0 of 34 survive BH FDR, so never claim October passes FDR.",
        "If a tool reports unavailable, state that honestly. Respond concisely in the user language (Bangla, Banglish, or English).",
        'Return plain text or JSON {"answer": "...", "speech": "...", "sectorId": "..."} grounded strictly in tool outputs.',
    ]
)

# Mirrors AGENT_TOOL_DEFINITIONS in server/agent/toolRegistry.js
TOOLS_SCHEMA: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "resolve_bangladesh_location",
            "description": "Resolve a Bangladesh district, upazila, coastal sector, or Bangla/Banglish place name to coordinates and sector id.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "District or sector name in English, Banglish, or Bangla.",
                    }
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_climate_trends",
            "description": "Query reproducible 2001-2025 NASA MERRA-2 2m temperature trend metrics (Mann-Kendall, Theil-Sen slope, Benjamini-Hochberg FDR).",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "mode": {
                        "type": "string",
                        "enum": [
                            "cell_month",
                            "month_summary",
                            "fastest_warming",
                            "significance_overview",
                            "seasonal_dissociation",
                        ],
                    },
                    "districtId": {"type": "string"},
                    "lat": {"type": "number", "minimum": -90, "maximum": 90},
                    "lon": {"type": "number", "minimum": -180, "maximum": 180},
                    "month": {"type": "string"},
                },
                "required": ["mode"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_live_weather",
            "description": "Fetch live current weather conditions (temperature, precipitation, wind, clouds) for a Bangladesh district or coordinate.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "districtId": {"type": "string"},
                    "lat": {"type": "number", "minimum": -90, "maximum": 90},
                    "lon": {"type": "number", "minimum": -180, "maximum": 180},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_active_fires",
            "description": "Check NASA FIRMS VIIRS/MODIS active fire detections over Bangladesh or near a district in the trailing 24 hours.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "districtId": {"type": "string"},
                    "lat": {"type": "number", "minimum": -90, "maximum": 90},
                    "lon": {"type": "number", "minimum": -180, "maximum": 180},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_crop_advisory",
            "description": "Generate climate-informed Bangladesh agricultural guidance combining live weather and observed MERRA-2 warming trends.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "districtId": {"type": "string"},
                    "lat": {"type": "number", "minimum": -90, "maximum": 90},
                    "lon": {"type": "number", "minimum": -180, "maximum": 180},
                },
            },
        },
    },
]


def load_districts() -> dict[str, dict[str, Any]]:
    """Load canonical 64+ Bangladesh districts directly from src/agent/bangladeshDistricts.js."""
    script = (
        "import { BANGLADESH_DISTRICTS } from './src/agent/bangladeshDistricts.js';"
        "console.log(JSON.stringify(BANGLADESH_DISTRICTS));"
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def load_trends_csv(csv_path: Path = DEFAULT_CSV) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with csv_path.open("r", encoding="utf-8") as fh:
        for raw in csv.DictReader(fh):
            rows.append(
                {
                    "latitude": float(raw["latitude"]),
                    "longitude": float(raw["longitude"]),
                    "insideBangladesh": raw["inside_bangladesh"].strip().lower() == "true",
                    "month": raw["month"].strip(),
                    "nYears": int(raw["n_years"]),
                    "mkS": float(raw["mk_S"]),
                    "mkZ": float(raw["mk_Z"]),
                    "pValue": float(raw["p_value"]),
                    "senSlopePerDecade": float(raw["sen_slope_c_per_decade"]),
                    "lag1R": float(raw["lag1_r"]),
                    "prewhitened": raw["prewhitened"].strip().lower() == "true",
                    "pValueTfpw": float(raw["p_value_tfpw"]),
                    "significantP05": raw["significant_p05"].strip().lower() == "true",
                    "significantFdr05": raw["significant_fdr05"].strip().lower() == "true",
                }
            )
    return rows


def nearest_cell(lat: float, lon: float, inside_rows: list[dict[str, Any]]) -> tuple[float, float]:
    cells = {(r["latitude"], r["longitude"]) for r in inside_rows}
    return min(cells, key=lambda c: (c[0] - lat) ** 2 + (c[1] - lon) ** 2)


def make_tool_call_msg(call_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [
            {
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
            }
        ],
    }


def make_tool_response_msg(call_id: str, name: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": call_id,
        "name": name,
        "content": json.dumps(payload, ensure_ascii=False),
    }


def make_final_msg(answer: str, speech: str, sector_id: str | None = None) -> dict[str, Any]:
    obj: dict[str, Any] = {"answer": answer, "speech": speech}
    if sector_id:
        obj["sectorId"] = sector_id
    return {
        "role": "assistant",
        "content": json.dumps(obj, ensure_ascii=False),
    }


def format_p(p: float) -> str:
    return f"{p:.5f}" if p < 0.0001 else f"{p:.4f}"


def month_bn(month: str) -> str:
    mapping = {
        "January": "জানুয়ারি",
        "February": "ফেব্রুয়ারি",
        "March": "মার্চ",
        "April": "এপ্রিল",
        "May": "মে",
        "June": "জুন",
        "July": "জুলাই",
        "August": "আগস্ট",
        "September": "সেপ্টেম্বর",
        "October": "অক্টোবর",
        "November": "নভেম্বর",
        "December": "ডিসেম্বর",
        "Annual": "বার্ষিক গড়",
    }
    return mapping.get(month, month)


def fdr_note_en(row: dict[str, Any]) -> str:
    if row["significantFdr05"]:
        return "statistically significant after Benjamini-Hochberg FDR (q=0.05)"
    if row["significantP05"]:
        return "nominally significant at p<0.05, but does NOT survive BH FDR (q=0.05)"
    return "not statistically significant"


def fdr_note_bn(row: dict[str, Any]) -> str:
    if row["significantFdr05"]:
        return "Benjamini-Hochberg FDR (q=0.05) অনুযায়ী পরিসংখ্যানগতভাবে তাৎপর্যপূর্ণ"
    if row["significantP05"]:
        return "p<0.05 হলেও BH FDR (q=0.05)-এ উত্তীর্ণ নয়"
    return "পরিসংখ্যানগতভাবে তাৎপর্যপূর্ণ নয়"


def build_cell_month_example(
    example_id: str,
    split: str,
    lang: str,
    prompt: str,
    district: dict[str, Any],
    row: dict[str, Any],
    category: str,
) -> dict[str, Any]:
    call_id = "call_1"
    args = {
        "mode": "cell_month",
        "districtId": district["id"],
        "month": row["month"],
    }
    tool_result = {
        "ok": True,
        "mode": "cell_month",
        "source": "NASA POWER / MERRA-2 T2M (2001-2025)",
        "sector": {
            "id": district["id"],
            "name": district["name"],
            "bnName": district.get("bnName"),
            "lat": district["lat"],
            "lon": district["lon"],
        },
        "cell": {"latitude": row["latitude"], "longitude": row["longitude"]},
        "month": row["month"],
        "record": row,
    }
    sign = "+" if row["senSlopePerDecade"] >= 0 else ""
    slope_str = f"{sign}{row['senSlopePerDecade']:.3f}°C/decade"
    p_str = format_p(row["pValue"])

    if lang == "bn":
        place = district.get("bnName") or district["name"]
        answer = (
            f"{place}-এর কাছাকাছি MERRA-2 গ্রিড সেলে ({row['latitude']}°N, {row['longitude']}°E) "
            f"{month_bn(row['month'])} মাসে তাপমাত্রার Theil-Sen প্রবণতা {sign}{row['senSlopePerDecade']:.3f}°C/দশক "
            f"(Mann-Kendall p = {p_str}, {fdr_note_bn(row)})।"
        )
        speech = (
            f"For {district['name']}, {row['month']} shows {slope_str} with p equals {p_str}."
        )
    elif lang == "banglish":
        answer = (
            f"{district['name']} er kachakachi MERRA-2 cell ({row['latitude']}°N, {row['longitude']}°E)-te "
            f"{row['month']} mashe trend {slope_str} (p = {p_str}; {fdr_note_en(row)})."
        )
        speech = (
            f"Nearest MERRA-2 cell for {district['name']} in {row['month']}: {slope_str}, p equals {p_str}."
        )
    else:
        answer = (
            f"Nearest MERRA-2 grid cell for {district['name']} ({row['latitude']}°N, {row['longitude']}°E) "
            f"in {row['month']}: Theil-Sen slope {slope_str} (Mann-Kendall p = {p_str}, {fdr_note_en(row)})."
        )
        speech = answer

    return {
        "id": example_id,
        "split": split,
        "category": category,
        "language": lang,
        "district_id": district["id"],
        "month": row["month"],
        "tools": TOOLS_SCHEMA,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
            make_tool_call_msg(call_id, "query_climate_trends", args),
            make_tool_response_msg(call_id, "query_climate_trends", tool_result),
            make_final_msg(answer, speech, district["id"]),
        ],
    }


def build_global_and_safety_examples(
    inside_rows: list[dict[str, Any]],
    districts: dict[str, dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    """Generate stratified global significance, seasonal dissociation, weather, fire, and crop examples."""
    by_split: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "test": []}

    barisal_sep = next(
        r
        for r in inside_rows
        if r["latitude"] == 22.5 and r["longitude"] == 90.0 and r["month"] == "September"
    )

    fastest_prompts = {
        "train": [
            ("en", "Where is warming fastest in Bangladesh?"),
            ("en", "Which region shows the strongest confirmed temperature trend?"),
            ("bn", "বাংলাদেশে কোথায় সবচেয়ে বেশি গরম বাড়ছে?"),
            ("banglish", "Bangladesh e kothay shobcheye beshi gorom bartese?"),
        ],
        "val": [
            ("en", "Identify the primary warming hotspot in Bangladesh from MERRA-2."),
            ("bn", "সবচেয়ে দ্রুত উষ্ণ হওয়া উপকূলীয় অঞ্চল কোনটি?"),
        ],
        "test": [
            ("en", "Show me the strongest FDR-confirmed warming hotspot in Bangladesh."),
            ("banglish", "Kon jaygay September warming shobcheye strong?"),
        ],
    }

    fastest_tool_payload = {
        "ok": True,
        "mode": "fastest_warming",
        "source": "NASA POWER / MERRA-2 T2M (2001-2025)",
        "barisalCoastSeptember": barisal_sep,
        "septemberSummary": {
            "month": "September",
            "cellCount": 34,
            "medianSenSlopePerDecade": 0.36,
            "significantP05Count": 34,
            "significantFdr05Count": 31,
        },
        "octoberSummary": {
            "month": "October",
            "cellCount": 34,
            "medianSenSlopePerDecade": 0.389,
            "significantP05Count": 29,
            "significantFdr05Count": 0,
        },
    }

    for split, items in fastest_prompts.items():
        for idx, (lang, prompt) in enumerate(items):
            if lang == "bn":
                ans = (
                    "৩৪টি MERRA-2 গ্রিড সেলের মধ্যে সেপ্টেম্বর মাসে উষ্ণায়ন সবচেয়ে নির্ভরযোগ্য: "
                    "বরিশাল উপকূলে (22.5°N, 90.0°E) হার +0.400°C/দশক (Mann-Kendall p = 0.00007, BH FDR q=0.05-এ উত্তীর্ণ)।"
                )
            elif lang == "banglish":
                ans = (
                    "September-e Barisal upokule (22.5°N, 90.0°E) warming rate +0.400°C/decade "
                    "(p = 0.00007, FDR-significant), ar saradeshe September median +0.360°C/decade (31/34 FDR-significant)."
                )
            else:
                ans = (
                    "Across all 34 Bangladesh MERRA-2 cells (2001–2025), September is the robust warming signal: "
                    "34/34 cells at p<0.05 and 31/34 after BH FDR (median +0.360°C/decade). "
                    "On the Barisal coast (22.5°N, 90.0°E), September warms at +0.400°C/decade (p = 0.00007)."
                )
            by_split[split].append(
                {
                    "id": f"fastest_{split}_{idx}",
                    "split": split,
                    "category": "fastest_warming",
                    "language": lang,
                    "tools": TOOLS_SCHEMA,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                        make_tool_call_msg(
                            "call_1",
                            "query_climate_trends",
                            {"mode": "fastest_warming"},
                        ),
                        make_tool_response_msg(
                            "call_1",
                            "query_climate_trends",
                            fastest_tool_payload,
                        ),
                        make_final_msg(
                            ans,
                            "On the Barisal coast, September warms at +0.40 degrees Celsius per decade, significant after FDR correction.",
                            "barisal",
                        ),
                    ],
                }
            )

    # Critical scientific trap: October FDR = 0/34 and Annual = 0/34
    trap_payload = {
        "ok": True,
        "mode": "significance_overview",
        "source": "NASA POWER / MERRA-2 T2M (2001-2025)",
        "totalCells": 34,
        "totalTests": 442,
        "significantP05Total": 106,
        "significantFdr05Total": 36,
        "september": {
            "month": "September",
            "medianSenSlopePerDecade": 0.36,
            "significantP05Count": 34,
            "significantFdr05Count": 31,
        },
        "october": {
            "month": "October",
            "medianSenSlopePerDecade": 0.389,
            "significantP05Count": 29,
            "significantFdr05Count": 0,
        },
        "annual": {
            "month": "Annual",
            "medianSenSlopePerDecade": 0.021,
            "significantP05Count": 0,
            "significantFdr05Count": 0,
        },
    }

    trap_prompts = {
        "train": [
            ("en", "Is October warming statistically significant after FDR correction?"),
            ("en", "Does the annual mean temperature show warming across Bangladesh?"),
            ("bn", "অক্টোবর মাসের উষ্ণায়ন কি FDR টেস্টে টিকেছে?"),
            ("banglish", "Annual average dekhe ki warming bujha jay?"),
        ],
        "val": [
            ("en", "Compare September vs October FDR significance and annual mean trends."),
            ("bn", "বার্ষিক গড় তাপমাত্রা আর সেপ্টেম্বর-অক্টোবরের পার্থক্য কী?"),
        ],
        "test": [
            ("en", "Is warming statistically significant across Bangladesh, including October and annual averages?"),
            ("banglish", "October ar annual mean ki FDR significant?"),
        ],
    }

    for split, items in trap_prompts.items():
        for idx, (lang, prompt) in enumerate(items):
            if lang == "bn":
                ans = (
                    "৩৪টি সেলের ৪৪২টি টেস্টে সেপ্টেম্বরে ৩১/৩৪ সেল BH FDR (q=0.05)-এ উত্তীর্ণ। "
                    "কিন্তু অক্টোবরে ২৯/৩৪ সেলে p<0.05 হলেও FDR-এ ০/৩৪ টিকেছে, আর বার্ষিক গড়ে ০/৩৪ সেল significant।"
                )
            elif lang == "banglish":
                ans = (
                    "September-e 31/34 cell FDR-significant, kintu October-e 29/34 p<0.05 holeo 0/34 FDR-e tikeche, "
                    "ar annual mean-e 0/34 cell significant (median +0.021°C/decade)."
                )
            else:
                ans = (
                    "September warming survives BH FDR (q=0.05) in 31 of 34 cells (34/34 at p<0.05). "
                    "October shows nominal warming in 29/34 cells at p<0.05 (median +0.389°C/decade) but 0 of 34 survive FDR, "
                    "and the annual mean shows 0 of 34 significant cells (median +0.021°C/decade)."
                )
            by_split[split].append(
                {
                    "id": f"significance_trap_{split}_{idx}",
                    "split": split,
                    "category": "fdr_and_annual_trap",
                    "language": lang,
                    "tools": TOOLS_SCHEMA,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                        make_tool_call_msg(
                            "call_1",
                            "query_climate_trends",
                            {"mode": "significance_overview"},
                        ),
                        make_tool_response_msg(
                            "call_1",
                            "query_climate_trends",
                            trap_payload,
                        ),
                        make_final_msg(
                            ans,
                            "September is FDR-significant in 31 of 34 cells, whereas October and the annual mean have 0 of 34 cells surviving FDR.",
                            "bangladesh",
                        ),
                    ],
                }
            )

    # Live weather + unavailable honesty examples
    weather_cases = [
        (
            "train",
            "en",
            "barisal",
            "What is the live weather in Barisal right now?",
            True,
            30.4,
            0.0,
            9.5,
        ),
        (
            "train",
            "bn",
            "sylhet",
            "সিলেটের বর্তমান আবহাওয়া ও বৃষ্টিপাত কেমন?",
            True,
            26.8,
            4.2,
            12.0,
        ),
        (
            "train",
            "en",
            "dhaka",
            "Check live weather for Dhaka.",
            False,
            None,
            None,
            None,
        ),
        (
            "val",
            "banglish",
            "rangamati",
            "Rangamati te ekhon weather kemon?",
            True,
            25.1,
            0.4,
            6.1,
        ),
        (
            "test",
            "en",
            "pirojpur",
            "Give me current weather conditions in Pirojpur.",
            False,
            None,
            None,
            None,
        ),
    ]
    for idx, (split, lang, dist_id, prompt, ready, temp, precip, wind) in enumerate(weather_cases):
        d = districts[dist_id]
        if ready:
            payload = {
                "ok": True,
                "status": "ready",
                "source": "Open-Meteo Current Weather API",
                "location": d["name"],
                "sectorId": dist_id,
                "coordinates": {"lat": d["lat"], "lon": d["lon"]},
                "condition": "RAIN" if (precip or 0) > 0 else "PARTLY CLOUDY",
                "weather": {
                    "temperatureC": temp,
                    "precipitationMm": precip,
                    "windKph": wind,
                },
            }
            if lang == "bn":
                ans = f"{d.get('bnName', d['name'])}-এর বর্তমান আবহাওয়া (Open-Meteo): তাপমাত্রা {temp}°C, বৃষ্টিপাত {precip} mm, বাতাস {wind} km/h।"
            elif lang == "banglish":
                ans = f"{d['name']} er bortoman weather (Open-Meteo): tapmatra {temp}°C, brishti {precip} mm, wind {wind} km/h."
            else:
                ans = f"Live Open-Meteo conditions for {d['name']}: {temp}°C, precipitation {precip} mm, wind {wind} km/h."
        else:
            payload = {
                "ok": True,
                "status": "unavailable",
                "reason": "Open-Meteo weather upstream unavailable",
                "location": d["name"],
                "sectorId": dist_id,
                "coordinates": {"lat": d["lat"], "lon": d["lon"]},
            }
            ans = (
                f"Live weather telemetry for {d['name']} is currently unavailable "
                "(Open-Meteo weather upstream unavailable). No synthetic fallback values were generated."
            )
        by_split[split].append(
            {
                "id": f"weather_{split}_{idx}",
                "split": split,
                "category": "live_weather" if ready else "unavailable_feed_honesty",
                "language": lang,
                "tools": TOOLS_SCHEMA,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                    make_tool_call_msg(
                        "call_1",
                        "get_live_weather",
                        {"districtId": dist_id},
                    ),
                    make_tool_response_msg("call_1", "get_live_weather", payload),
                    make_final_msg(ans, ans, dist_id),
                ],
            }
        )

    # NASA FIRMS active fire examples (ready + unavailable honesty)
    fire_cases = [
        ("train", "en", "chittagong", "Are there any active NASA FIRMS fires near Chittagong?", False, None),
        ("train", "bn", "khulna", "খুলনা অঞ্চলে কি কোনো সক্রিয় আগুন শনাক্ত হয়েছে?", True, 2),
        ("val", "en", "rangamati", "Check NASA FIRMS fire detections in Rangamati.", True, 0),
        ("test", "en", "coxsbazar", "Any active wildfire detections in Cox's Bazar in the last 24h?", False, None),
    ]
    for idx, (split, lang, dist_id, prompt, ready, count) in enumerate(fire_cases):
        d = districts[dist_id]
        if ready:
            payload = {
                "ok": True,
                "source": "NASA FIRMS VIIRS/MODIS NRT (trailing 24h)",
                "sectorId": dist_id,
                "location": d["name"],
                "status": "ready",
                "count": count,
                "detections": [],
            }
            ans = (
                f"{d.get('bnName', d['name'])}-এ গত ২৪ ঘণ্টায় NASA FIRMS-এ {count}টি সক্রিয় তাপ উৎস শনাক্ত হয়েছে।"
                if lang == "bn"
                else f"NASA FIRMS trailing 24h check for {d['name']}: {count} active fire detection(s)."
            )
        else:
            payload = {
                "ok": True,
                "source": "NASA FIRMS VIIRS/MODIS NRT (trailing 24h)",
                "sectorId": dist_id,
                "location": d["name"],
                "status": "unavailable",
                "reason": "FIRMS_MAP_KEY not configured and no local cache present",
                "count": None,
                "detections": [],
            }
            ans = f"NASA FIRMS active fire feed for {d['name']} is currently unavailable (FIRMS_MAP_KEY not configured and no local cache present)."
        by_split[split].append(
            {
                "id": f"fires_{split}_{idx}",
                "split": split,
                "category": "active_fires" if ready else "unavailable_feed_honesty",
                "language": lang,
                "tools": TOOLS_SCHEMA,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                    make_tool_call_msg(
                        "call_1",
                        "get_active_fires",
                        {"districtId": dist_id},
                    ),
                    make_tool_response_msg("call_1", "get_active_fires", payload),
                    make_final_msg(ans, ans, dist_id),
                ],
            }
        )

    # Crop advisory examples
    crop_cases = [
        ("train", "en", "barisal", "Give farmer crop advisory for Barisal."),
        ("train", "bn", "sylhet", "সিলেটের কৃষকদের জন্য ফসল ও চাষাবাদ পরামর্শ দাও।"),
        ("val", "banglish", "habiganj", "Habiganj e krishokder jonno fosol poramorsho dao."),
        ("test", "en", "dinajpur", "What agricultural crop action fits Dinajpur warming trends?"),
    ]
    for idx, (split, lang, dist_id, prompt) in enumerate(crop_cases):
        d = districts[dist_id]
        c_lat, c_lon = nearest_cell(d["lat"], d["lon"], inside_rows)
        sep_row = next(
            r
            for r in inside_rows
            if r["latitude"] == c_lat and r["longitude"] == c_lon and r["month"] == "September"
        )
        payload = {
            "ok": True,
            "advisoryBasis": "rule-based-climate-plus-live-weather",
            "location": d["name"],
            "sectorId": dist_id,
            "weatherStatus": "ready",
            "weather": {"temperatureC": 29.5, "precipitationMm": 0.0},
            "septemberTrend": sep_row,
            "recommendations": [
                "Maintain 2–3 cm standing water during Aman reproductive/grain-filling stages and monitor field drainage.",
                "Post-monsoon warming signal (September MERRA-2 trend): consider heat-tolerant paddy varieties (e.g. BRRI dhan 75 / 87) and shift early Rabi wheat/mustard sowing 7–10 days if warm anomalies persist.",
            ],
        }
        slope_str = f"+{sep_row['senSlopePerDecade']:.2f}°C/decade"
        if lang == "bn":
            ans = (
                f"{d.get('bnName', d['name'])}-এর কৃষি পরামর্শ: সেপ্টেম্বর মাসে MERRA-2 তাপমাত্রা বৃদ্ধির হার {slope_str} "
                "(বর্তমান তাপমাত্রা ২৯.৫°C)। আমন ধানে ২–৩ সেমি পানি ধরে রাখুন এবং তাপ-সহনশীল জাত (BRRI dhan 75/87) বিবেচনা করুন।"
            )
        elif lang == "banglish":
            ans = (
                f"{d['name']} crop advisory: September warming {slope_str} ar live temp 29.5°C. "
                "Aman dhane 2-3 cm pani rakhun ebong gorom sohonshil BRRI dhan 75/87 o Rabi bij bopone 7-10 din adjust korun."
            )
        else:
            ans = (
                f"Crop advisory for {d['name']} (September MERRA-2 trend {slope_str}, live temp 29.5°C): "
                "Maintain 2–3 cm standing water for Aman paddy, consider heat-tolerant BRRI dhan 75/87, and adjust early Rabi sowing if heat persists."
            )
        by_split[split].append(
            {
                "id": f"crop_{split}_{idx}",
                "split": split,
                "category": "crop_advisory",
                "language": lang,
                "tools": TOOLS_SCHEMA,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                    make_tool_call_msg(
                        "call_1",
                        "get_crop_advisory",
                        {"districtId": dist_id},
                    ),
                    make_tool_response_msg("call_1", "get_crop_advisory", payload),
                    make_final_msg(ans, ans, dist_id),
                ],
            }
        )

    return by_split


def build_splits(
    csv_path: Path = DEFAULT_CSV,
    config_path: Path = DEFAULT_CONFIG,
    seed: int = 42,
) -> dict[str, list[dict[str, Any]]]:
    rng = random.Random(seed)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    val_heldout = set(config["dataset"]["val_heldout_districts"])
    test_heldout = set(config["dataset"]["test_heldout_districts"])

    districts = load_districts()
    all_rows = load_trends_csv(csv_path)
    inside_rows = [r for r in all_rows if r["insideBangladesh"]]

    lookup = {(r["latitude"], r["longitude"], r["month"]): r for r in inside_rows}
    splits: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "test": []}

    focus_months = ["September", "October", "Annual", "July", "May"]
    seen_prompts: set[str] = set()

    for dist_id, dist in sorted(districts.items()):
        c_lat, c_lon = nearest_cell(dist["lat"], dist["lon"], inside_rows)
        if dist_id in test_heldout:
            split = "test"
        elif dist_id in val_heldout:
            split = "val"
        else:
            split = "train"

        bn_name = dist.get("bnName") or dist["name"]
        short_name = dist["name"].replace(" District", "")

        for month in focus_months:
            row = lookup.get((c_lat, c_lon, month))
            if not row:
                continue

            if split == "train":
                candidates = [
                    ("en", f"What is the {month} temperature trend in {short_name}?"),
                    ("bn", f"{bn_name}-এ {month_bn(month)} মাসে তাপমাত্রা কেমন বদলাচ্ছে?"),
                ]
                if month == "September":
                    candidates.append(
                        ("banglish", f"{short_name} e September temperature trend kemon?")
                    )
            elif split == "val":
                candidates = [
                    ("en", f"Check MERRA-2 {month} warming statistics for {short_name}."),
                    ("bn", f"{bn_name} জেলার {month_bn(month)} তাপমাত্রার প্রবণতা দেখাও।"),
                ]
            else:
                candidates = [
                    ("en", f"Analyze {month} T2M Mann-Kendall trend for {short_name}."),
                    ("banglish", f"{short_name} er {month} temperature trend o p-value bolo."),
                ]

            for idx, (lang, prompt) in enumerate(candidates):
                norm_prompt = prompt.strip().lower()
                if norm_prompt in seen_prompts:
                    continue
                seen_prompts.add(norm_prompt)
                splits[split].append(
                    build_cell_month_example(
                        example_id=f"cell_{dist_id}_{month.lower()}_{lang}_{idx}",
                        split=split,
                        lang=lang,
                        prompt=prompt,
                        district=dist,
                        row=row,
                        category="district_climate_trend",
                    )
                )

    extra = build_global_and_safety_examples(inside_rows, districts)
    for split, items in extra.items():
        for item in items:
            prompt_key = item["messages"][1]["content"].strip().lower()
            if prompt_key not in seen_prompts:
                seen_prompts.add(prompt_key)
                splits[split].append(item)

    for items in splits.values():
        rng.shuffle(items)
    return splits


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def select_reviewed_sample(splits: dict[str, list[dict[str, Any]]], limit: int = 18) -> list[dict[str, Any]]:
    sample: list[dict[str, Any]] = []
    categories_wanted = [
        ("train", "fastest_warming"),
        ("train", "fdr_and_annual_trap"),
        ("train", "live_weather"),
        ("train", "unavailable_feed_honesty"),
        ("train", "crop_advisory"),
        ("val", "district_climate_trend"),
        ("test", "district_climate_trend"),
        ("test", "fdr_and_annual_trap"),
    ]
    used_ids: set[str] = set()
    for split, category in categories_wanted:
        for item in splits[split]:
            if item["category"] == category and item["id"] not in used_ids:
                sample.append(item)
                used_ids.add(item["id"])
                if len(sample) >= limit:
                    return sample
    for split in ("test", "val", "train"):
        for item in splits[split]:
            if item["id"] not in used_ids:
                sample.append(item)
                used_ids.add(item["id"])
                if len(sample) >= limit:
                    return sample
    return sample


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parent / "artifacts")
    parser.add_argument(
        "--reviewed-out",
        type=Path,
        default=Path(__file__).resolve().parent / "examples" / "reviewed_examples.jsonl",
    )
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    splits = build_splits(seed=args.seed)
    for split_name, rows in splits.items():
        write_jsonl(args.out_dir / f"{split_name}.jsonl", rows)

    reviewed = select_reviewed_sample(splits, limit=18)
    write_jsonl(args.reviewed_out, reviewed)

    summary = {split: len(rows) for split, rows in splits.items()}
    summary["reviewed_examples"] = len(reviewed)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
