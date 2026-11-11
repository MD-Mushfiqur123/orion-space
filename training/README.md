# Orion-0.6B v0.1 Training Pipeline (Phase 3)

Reproducible LoRA Supervised Fine-Tuning (SFT) pipeline for **`Qwen/Qwen3-0.6B`** aligned with Orion Space's Phase 2 Node.js Agent Backend (`server/agent/`).

> **Repository rule:** Never commit model weights, `.safetensors`/`.bin` checkpoints, or large generated artifacts to GitHub. Store exported LoRA adapters or merged weights in private model storage (e.g., private Hugging Face Hub repo).

## 1. Local Dataset Build & Validation

Build leak-free `train`, `val`, and `test` splits directly from `analysis/results/t2m_trends_by_cell_month.csv` and `src/agent/bangladeshDistricts.js`:

```bash
python3 training/build_dataset.py
python3 training/validate_dataset.py
python3 -m unittest training/test_pipeline.py
```

Outputs:
- `training/artifacts/train.jsonl` (gitignored full split)
- `training/artifacts/val.jsonl` (gitignored held-out districts + phrasings)
- `training/artifacts/test.jsonl` (gitignored held-out districts + phrasings)
- `training/examples/reviewed_examples.jsonl` (18 curated examples tracked in git)

## 2. Kaggle T4 GPU Training & Evaluation

Open `training/kaggle_qwen3_orion_lora.ipynb` on Kaggle with **GPU T4 x2 / T4** enabled, or run the CLI scripts directly on a CUDA host:

```bash
pip install -r training/requirements-kaggle.txt
python3 training/build_dataset.py
python3 training/validate_dataset.py
python3 training/train_lora.py --merge-output training/outputs/orion-qwen3-0.6b-merged
python3 training/evaluate.py --compare-base \
  --adapter-dir training/outputs/orion-qwen3-0.6b-lora/adapter \
  --out-report training/outputs/eval_report.json
```

Optional private Hugging Face upload (reads `HF_TOKEN` from environment, never hardcode secrets):

```bash
export HF_TOKEN=hf_...
python3 training/train_lora.py \
  --merge-output training/outputs/orion-qwen3-0.6b-merged \
  --push-to-hub <your-username>/orion-qwen3-0.6b
```

## 3. Ready for Phase 4

Before Phase 4 deployment, bring back:
1. Exported model artifact location (private HF repo or downloaded LoRA/merged artifact)
2. `training/outputs/training_summary.json` (includes `base_model_revision`)
3. `training/outputs/eval_report.json` (`base_model_eval` vs `fine_tuned_eval`)
