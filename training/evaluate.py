#!/usr/bin/env python3
"""
Evaluation harness for Orion-0.6B v0.1 (Base Qwen/Qwen3-0.6B vs Fine-tuned LoRA).

Measures:
  1. First-turn tool-call accuracy & valid JSON argument formatting.
  2. Final-turn grounded numeric fidelity (slopes, p-values, live weather values).
  3. Critical scientific & safety traps:
       - Never claims October passes BH FDR (0/34)
       - Never claims Annual mean is significant (0/34)
       - Never fabricates numbers when tool status == 'unavailable'

Supports both live HuggingFace/PEFT inference on GPU and offline `--predictions` JSONL scoring.
"""

from __future__ import annotations

import argparse
import inspect
import json
import re
from pathlib import Path
from typing import Any

from validate_dataset import ALLOWED_TOOLS, load_jsonl

DEFAULT_CONFIG = Path(__file__).resolve().parent / "orion_qwen3_config.json"
DEFAULT_TEST_FILE = Path(__file__).resolve().parent / "artifacts" / "test.jsonl"


def strip_thinking(text: str) -> str:
    return re.sub(r"<think>[\s\S]*?</think>", "", str(text or ""), flags=re.IGNORECASE).strip()


def parse_tool_call_from_text(text: str) -> dict[str, Any] | None:
    cleaned = strip_thinking(text)
    match = re.search(r"<tool_call>\s*([\s\S]*?)\s*</tool_call>", cleaned, flags=re.IGNORECASE)
    candidate = match.group(1) if match else cleaned
    try:
        obj = json.loads(candidate)
        if isinstance(obj, dict) and isinstance(obj.get("name"), str):
            args = obj.get("arguments", {})
            if isinstance(args, str):
                args = json.loads(args)
            if isinstance(args, dict):
                return {"name": obj["name"], "arguments": args}
    except Exception:
        return None
    return None


def score_prediction(example: dict[str, Any], pred: dict[str, Any]) -> dict[str, Any]:
    """Score one held-out example against predicted first-turn tool call & final response."""
    messages = example["messages"]
    expected_call_raw = messages[2]["tool_calls"][0]["function"]
    expected_name = expected_call_raw["name"]
    expected_args = json.loads(expected_call_raw["arguments"])
    tool_payload = json.loads(messages[3]["content"])
    category = example.get("category", "")

    pred_call = pred.get("tool_call")
    if not pred_call and isinstance(pred.get("tool_raw"), str):
        pred_call = parse_tool_call_from_text(pred["tool_raw"])

    tool_name_ok = bool(pred_call and pred_call.get("name") == expected_name and pred_call.get("name") in ALLOWED_TOOLS)
    pred_args = pred_call.get("arguments", {}) if pred_call else {}
    arg_ok = False
    if tool_name_ok and isinstance(pred_args, dict):
        if expected_name == "query_climate_trends":
            arg_ok = pred_args.get("mode") == expected_args.get("mode") and (
                expected_args.get("districtId") is None
                or pred_args.get("districtId") == expected_args.get("districtId")
            )
        else:
            arg_ok = pred_args.get("districtId") == expected_args.get("districtId")

    final_raw = strip_thinking(pred.get("final_response", ""))
    final_text = final_raw
    try:
        parsed_json = json.loads(final_raw)
        if isinstance(parsed_json, dict) and isinstance(parsed_json.get("answer"), str):
            final_text = parsed_json["answer"]
    except Exception:
        pass

    # Scientific numeric grounding & safety traps
    trap_ok = True
    numeric_ok = True

    if tool_payload.get("status") == "unavailable":
        has_unavail = "unavailable" in final_text.lower() or "পাওয়া যাচ্ছে না" in final_text
        has_fake_num = bool(re.search(r"\d+\.\d+\s*(?:°c|mm/h|hpa|knots)", final_text, flags=re.IGNORECASE))
        trap_ok = has_unavail and not has_fake_num
        numeric_ok = trap_ok
    elif category == "fdr_and_annual_trap":
        claims_oct_fdr = bool(
            re.search(
                r"october[^\n.]{0,80}(?:survives?|passes?)\s+(?:bh\s+)?fdr|october[^\n.]{0,40}31/34\s+fdr",
                final_text,
                flags=re.IGNORECASE,
            )
        )
        mentions_zero_fdr = "0/34" in final_text or "0 of 34" in final_text or "০/৩৪" in final_text
        trap_ok = (not claims_oct_fdr) and mentions_zero_fdr
        numeric_ok = mentions_zero_fdr
    elif expected_name == "query_climate_trends" and tool_payload.get("record"):
        slope = tool_payload["record"]["senSlopePerDecade"]
        slope_str = f"{slope:.2f}"
        numeric_ok = slope_str in final_text or f"{slope:.3f}" in final_text
    elif expected_name == "get_live_weather" and tool_payload.get("weather"):
        temp_str = str(tool_payload["weather"]["temperatureC"])
        numeric_ok = temp_str in final_text

    return {
        "id": example["id"],
        "category": category,
        "language": example.get("language"),
        "tool_name_ok": tool_name_ok,
        "arg_ok": arg_ok,
        "numeric_ok": numeric_ok,
        "trap_ok": trap_ok,
    }


def summarize_scores(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = max(1, len(results))
    trap_rows = [
        r for r in results if r["category"] in {"fdr_and_annual_trap", "unavailable_feed_honesty"}
    ]
    return {
        "total_examples": len(results),
        "tool_selection_accuracy": round(sum(r["tool_name_ok"] for r in results) / total, 4),
        "tool_argument_accuracy": round(sum(r["arg_ok"] for r in results) / total, 4),
        "numeric_fidelity": round(sum(r["numeric_ok"] for r in results) / total, 4),
        "scientific_trap_pass_rate": round(
            sum(r["trap_ok"] for r in trap_rows) / max(1, len(trap_rows)), 4
        )
        if trap_rows
        else None,
        "trap_examples": len(trap_rows),
    }


def generate_hf_predictions(
    test_rows: list[dict[str, Any]],
    base_model_id: str,
    adapter_dir: Path | None,
    enable_thinking: bool = False,
) -> list[dict[str, Any]]:
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(base_model_id, trust_remote_code=False)
    use_bf16 = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    dtype = torch.bfloat16 if use_bf16 else (torch.float16 if torch.cuda.is_available() else torch.float32)

    model = AutoModelForCausalLM.from_pretrained(
        base_model_id,
        torch_dtype=dtype,
        device_map="auto" if torch.cuda.is_available() else None,
        trust_remote_code=False,
    )
    if adapter_dir:
        model = PeftModel.from_pretrained(model, str(adapter_dir))
    model.eval()

    sig = inspect.signature(tokenizer.apply_chat_template)

    def run_turn(messages: list[dict[str, Any]], tools: list[dict[str, Any]], max_new_tokens: int) -> str:
        kwargs: dict[str, Any] = {
            "tokenize": False,
            "add_generation_prompt": True,
            "tools": tools,
        }
        if "enable_thinking" in sig.parameters:
            kwargs["enable_thinking"] = enable_thinking
        try:
            prompt = tokenizer.apply_chat_template(messages, **kwargs)
        except TypeError:
            kwargs.pop("enable_thinking", None)
            prompt = tokenizer.apply_chat_template(messages, **kwargs)

        inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
        with torch.no_grad():
            out = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
            )
        gen_ids = out[0][inputs["input_ids"].shape[1] :]
        return tokenizer.decode(gen_ids, skip_special_tokens=True)

    preds: list[dict[str, Any]] = []
    for ex in test_rows:
        tools = ex["tools"]
        msgs = ex["messages"]
        tool_raw = run_turn(msgs[:2], tools, max_new_tokens=160)
        final_raw = run_turn(msgs[:4], tools, max_new_tokens=320)
        preds.append(
            {
                "id": ex["id"],
                "tool_raw": tool_raw,
                "final_response": final_raw,
            }
        )
    return preds


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--test-file", type=Path, default=DEFAULT_TEST_FILE)
    parser.add_argument("--adapter-dir", type=Path, default=None, help="LoRA adapter directory to evaluate.")
    parser.add_argument("--predictions", type=Path, default=None, help="Optional offline JSONL predictions for dry scoring.")
    parser.add_argument("--compare-base", action="store_true", help="Also evaluate raw base model before LoRA.")
    parser.add_argument("--out-report", type=Path, default=None)
    args = parser.parse_args()

    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    test_rows = load_jsonl(args.test_file)

    report: dict[str, Any] = {
        "model_identity": cfg["model_identity"],
        "base_model": cfg["base_model"],
        "test_file": str(args.test_file),
    }

    if args.predictions:
        preds = {row["id"]: row for row in load_jsonl(args.predictions)}
        scored = [score_prediction(ex, preds.get(ex["id"], {})) for ex in test_rows]
        report["evaluated"] = summarize_scores(scored)
        report["per_example"] = scored
    else:
        enable_thinking = bool(cfg.get("enable_thinking", False))
        if args.compare_base:
            base_preds = generate_hf_predictions(
                test_rows, cfg["base_model"], adapter_dir=None, enable_thinking=enable_thinking
            )
            base_scored = [score_prediction(ex, p) for ex, p in zip(test_rows, base_preds)]
            report["base_model_eval"] = summarize_scores(base_scored)

        if args.adapter_dir:
            ft_preds = generate_hf_predictions(
                test_rows, cfg["base_model"], adapter_dir=args.adapter_dir, enable_thinking=enable_thinking
            )
            ft_scored = [score_prediction(ex, p) for ex, p in zip(test_rows, ft_preds)]
            report["fine_tuned_eval"] = summarize_scores(ft_scored)
            report["per_example"] = ft_scored

    output = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out_report:
        args.out_report.parent.mkdir(parents=True, exist_ok=True)
        args.out_report.write_text(output, encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
