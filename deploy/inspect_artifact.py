#!/usr/bin/env python3
"""
Orion Space — Phase 4 Model Artifact Inspector

Inspects and verifies trained Orion Qwen3-0.6B model artifacts before deployment:
- Base model identification & revision
- LoRA adapter vs merged model integrity
- Tokenizer chat template & tool tokens compatibility
- Evaluation report metrics vs production gates
- License, safety, and scientific attribution
- Production deployment recommendation
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


MIN_TOOL_ACCURACY = 0.80
MIN_SCHEMA_VALIDITY = 0.90
MIN_TRAP_AVOIDANCE = 0.95


class ArtifactInspector:
    def __init__(self, artifact_path: str):
        self.path = Path(artifact_path).resolve()
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.info: Dict[str, Any] = {}

    def inspect(self) -> Dict[str, Any]:
        if not self.path.exists():
            self.errors.append(f"Artifact path does not exist: {self.path}")
            return self._build_result(verified=False)

        is_adapter = (self.path / "adapter_config.json").exists()
        is_merged = (self.path / "config.json").exists() and not is_adapter

        if not is_adapter and not is_merged:
            self.errors.append(
                f"Directory at {self.path} has neither 'adapter_config.json' nor 'config.json'."
            )
            return self._build_result(verified=False)

        if is_adapter:
            self._inspect_adapter()
        else:
            self._inspect_merged()

        self._inspect_tokenizer()
        self._inspect_eval_report()
        self._inspect_license_attribution()
        self._determine_recommendation(is_merged=is_merged, is_adapter=is_adapter)

        verified = len(self.errors) == 0
        return self._build_result(verified=verified)

    def _inspect_adapter(self):
        self.info["artifact_type"] = "lora_adapter"
        adapter_cfg_file = self.path / "adapter_config.json"
        try:
            with open(adapter_cfg_file, "r", encoding="utf-8") as f:
                adapter_cfg = json.load(f)
            self.info["adapter_config"] = adapter_cfg
            base_model = adapter_cfg.get("base_model_name_or_path", "")
            self.info["base_model"] = base_model

            if "Qwen3-0.6B" not in base_model and "Qwen" not in base_model:
                self.warnings.append(
                    f"base_model_name_or_path is '{base_model}', expected 'Qwen/Qwen3-0.6B'."
                )

            # Check weights
            weights = list(self.path.glob("adapter_model*.safetensors")) or list(
                self.path.glob("adapter_model*.bin")
            )
            if not weights:
                self.errors.append("No adapter weights found (adapter_model.safetensors or .bin missing).")
            else:
                self.info["weight_files"] = [w.name for w in weights]
                total_mb = sum(w.stat().st_size for w in weights) / (1024 * 1024)
                self.info["weights_size_mb"] = round(total_mb, 2)

            # Training summary check
            summary_file = self.path / "training_summary.json"
            if summary_file.exists():
                with open(summary_file, "r", encoding="utf-8") as f:
                    summary = json.load(f)
                self.info["training_summary"] = summary
                self.info["base_model_revision"] = summary.get("base_model_revision", "unknown")
            else:
                self.warnings.append("training_summary.json not found in adapter directory.")
                self.info["base_model_revision"] = "untracked"

        except Exception as e:
            self.errors.append(f"Failed to read adapter_config.json: {e}")

    def _inspect_merged(self):
        self.info["artifact_type"] = "merged_model"
        cfg_file = self.path / "config.json"
        try:
            with open(cfg_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            self.info["model_config"] = cfg
            model_type = cfg.get("model_type", "")
            self.info["model_type"] = model_type

            # Check weights
            weights = list(self.path.glob("*.safetensors")) or list(self.path.glob("*.bin"))
            if not weights:
                self.errors.append("No model weight files found (*.safetensors or *.bin missing).")
            else:
                self.info["weight_files"] = [w.name for w in weights]
                total_mb = sum(w.stat().st_size for w in weights) / (1024 * 1024)
                self.info["weights_size_mb"] = round(total_mb, 2)

            self.info["base_model_revision"] = cfg.get("_commit_hash", "main")
        except Exception as e:
            self.errors.append(f"Failed to read config.json: {e}")

    def _inspect_tokenizer(self):
        tok_cfg_file = self.path / "tokenizer_config.json"
        if tok_cfg_file.exists():
            try:
                with open(tok_cfg_file, "r", encoding="utf-8") as f:
                    tok_cfg = json.load(f)
                self.info["tokenizer_class"] = tok_cfg.get("tokenizer_class", "Qwen2Tokenizer")
                self.info["has_chat_template"] = bool(tok_cfg.get("chat_template"))
            except Exception as e:
                self.warnings.append(f"Error parsing tokenizer_config.json: {e}")
        else:
            self.warnings.append("tokenizer_config.json not present in artifact directory.")

    def _inspect_eval_report(self):
        eval_file = self.path / "eval_report.json"
        if not eval_file.exists():
            # Check parent directory or outputs
            alt_eval = self.path.parent / "eval_report.json"
            if alt_eval.exists():
                eval_file = alt_eval

        if eval_file.exists():
            try:
                with open(eval_file, "r", encoding="utf-8") as f:
                    eval_data = json.load(f)
                self.info["eval_report"] = eval_data

                fine_tuned = eval_data.get("fine_tuned_eval", eval_data)
                tool_acc = fine_tuned.get("tool_accuracy", 1.0)
                schema_val = fine_tuned.get("schema_validity", 1.0)
                trap_avoid = fine_tuned.get("trap_avoidance", 1.0)

                if tool_acc < MIN_TOOL_ACCURACY:
                    self.errors.append(
                        f"Evaluation tool accuracy {tool_acc:.2%} below minimum {MIN_TOOL_ACCURACY:.0%}."
                    )
                if schema_val < MIN_SCHEMA_VALIDITY:
                    self.errors.append(
                        f"Evaluation schema validity {schema_val:.2%} below minimum {MIN_SCHEMA_VALIDITY:.0%}."
                    )
                if trap_avoid < MIN_TRAP_AVOIDANCE:
                    self.errors.append(
                        f"Evaluation scientific trap avoidance {trap_avoid:.2%} below minimum {MIN_TRAP_AVOIDANCE:.0%}."
                    )
            except Exception as e:
                self.warnings.append(f"Error parsing eval_report.json: {e}")
        else:
            self.warnings.append(
                "eval_report.json not found alongside artifact. Production deployment requires evaluated metrics."
            )

    def _inspect_license_attribution(self):
        self.info["license_base_model"] = "Apache-2.0"
        self.info["license_orion_code"] = "MIT"
        self.info["attribution"] = "Qwen3 upstream by Alibaba Cloud; Orion agent fine-tuning by Orion Space team."
        self.info["data_attribution"] = "NASA POWER (CERES/MERRA-2), Open-Meteo, NASA FIRMS."

    def _determine_recommendation(self, is_merged: bool, is_adapter: bool):
        if is_merged:
            self.info["recommendation"] = {
                "target_type": "merged_fine_tuned_model",
                "rationale": (
                    "Merged model is the simplest, lowest latency, zero-overhead production runtime. "
                    "Compatible with vLLM, llama.cpp, and standard PyTorch endpoints without PEFT dependency."
                ),
                "vllm_command_template": (
                    "python3 -m vllm.entrypoints.openai.api_server "
                    "--model {model_path} --served-model-name orion-qwen3-0.6b "
                    "--max-model-len 2048 --gpu-memory-utilization 0.85 --port 8000"
                ),
            }
        elif is_adapter:
            self.info["recommendation"] = {
                "target_type": "base_model_plus_lora_adapter",
                "alternative_action": "Merge adapter into base model before production deployment for simpler serving.",
                "merge_command": (
                    "python3 training/train_lora.py --merge-output --adapter-dir {adapter_path} "
                    "--merged-dir {merged_output_path}"
                ),
                "rationale": (
                    "Adapter is valid and lightweight (~20MB). For vLLM production, merging into base model "
                    "is recommended to eliminate multi-lora runtime overhead. Alternatively, vLLM supports "
                    "--enable-lora --lora-modules orion-qwen3-0.6b={adapter_path}."
                ),
            }

    def _build_result(self, verified: bool) -> Dict[str, Any]:
        return {
            "verified": verified,
            "path": str(self.path),
            "errors": self.errors,
            "warnings": self.warnings,
            "info": self.info,
        }


def format_report_cli(result: Dict[str, Any]) -> str:
    lines = []
    lines.append("=" * 70)
    lines.append("       ORION SPACE — PHASE 4 ARTIFACT INSPECTION REPORT")
    lines.append("=" * 70)
    status_str = "PASS (VERIFIED)" if result["verified"] else "FAIL (UNVERIFIED)"
    lines.append(f"Status:        {status_str}")
    lines.append(f"Artifact Path: {result['path']}")

    info = result.get("info", {})
    if "artifact_type" in info:
        lines.append(f"Type:          {info['artifact_type']}")
    if "base_model" in info:
        lines.append(f"Base Model:    {info['base_model']}")
    if "base_model_revision" in info:
        lines.append(f"Base Revision: {info['base_model_revision']}")
    if "weights_size_mb" in info:
        lines.append(f"Weights Size:  {info['weights_size_mb']} MB")
    if "weight_files" in info:
        lines.append(f"Weight Files:  {', '.join(info['weight_files'])}")

    lines.append("-" * 70)
    lines.append("LICENSING & ATTRIBUTION")
    lines.append(f"Base Model License: {info.get('license_base_model', 'N/A')}")
    lines.append(f"Code & Adapter:     {info.get('license_orion_code', 'N/A')}")
    lines.append(f"Attribution:        {info.get('attribution', 'N/A')}")
    lines.append(f"Scientific Sources: {info.get('data_attribution', 'N/A')}")

    if "eval_report" in info:
        lines.append("-" * 70)
        lines.append("EVALUATION GATES")
        ev = info["eval_report"].get("fine_tuned_eval", info["eval_report"])
        lines.append(f"Tool Accuracy:   {ev.get('tool_accuracy', 'N/A')}")
        lines.append(f"Schema Validity: {ev.get('schema_validity', 'N/A')}")
        lines.append(f"Trap Avoidance:  {ev.get('trap_avoidance', 'N/A')}")

    lines.append("-" * 70)
    lines.append("PRODUCTION RECOMMENDATION")
    rec = info.get("recommendation", {})
    lines.append(f"Target:    {rec.get('target_type', 'N/A')}")
    lines.append(f"Rationale: {rec.get('rationale', 'N/A')}")
    if "merge_command" in rec:
        lines.append(f"Merge Cmd: {rec.get('merge_command', '')}")

    if result.get("warnings"):
        lines.append("-" * 70)
        lines.append("WARNINGS:")
        for w in result["warnings"]:
            lines.append(f"  [!] {w}")

    if result.get("errors"):
        lines.append("-" * 70)
        lines.append("ERRORS:")
        for e in result["errors"]:
            lines.append(f"  [X] {e}")

    lines.append("=" * 70)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Inspect Orion Qwen3-0.6B model artifact")
    parser.add_argument("artifact_path", help="Path to adapter or merged model directory")
    parser.add_argument("--json", action="store_true", help="Output results in JSON format")
    args = parser.parse_args()

    inspector = ArtifactInspector(args.artifact_path)
    result = inspector.inspect()

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(format_report_cli(result))

    sys.exit(0 if result["verified"] else 1)


if __name__ == "__main__":
    main()

