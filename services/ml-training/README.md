# procur-ml-training

GraphSAGE training pipeline for procur's ML layer.
Component B per `docs/procur-ml-layer-brief.md` §5.

## Layout

This is the only Python project in the procur monorepo. It lives
beside `services/ai-pipeline` (TypeScript) but uses its own
ecosystem (uv / pip / pyproject.toml). Do not try to wire it into
turbo or pnpm.

```
services/ml-training/
├── pyproject.toml         # deps + project config
├── src/procur_ml/
│   ├── dataset.py         # JSON graph extract → torch_geometric HeteroData
│   ├── model.py           # heterogeneous GraphSAGE module
│   ├── train.py           # link-prediction training loop + MLflow
│   └── upsert.py          # write embeddings → procur Postgres
```

## End-to-end workflow

```sh
# 1. Extract the graph from procur Postgres (TypeScript side)
cd packages/db
pnpm run extract-graph --output ../../graph.json

# 2. Set up Python environment (one-time)
cd ../../services/ml-training
uv venv               # or python -m venv .venv
source .venv/bin/activate
uv pip install -e .   # or pip install -e .

# 3. Train
python -m procur_ml.train --graph ../../graph.json --output embeddings.json --epochs 50

# 4. Upsert into procur Postgres (reads DATABASE_URL from .env.local)
python -m procur_ml.upsert --embeddings embeddings.json --kind graph_v1
```

After step 4, the catalog API `findSimilarEntities()` (shipped in
Component A — PR #419) starts returning real cosine-similarity
results.

## Hardware

Single GPU recommended for training. Procur scale (~10K total
nodes) fits comfortably on any modern card; CPU-only training works
but is slower.

For a rented A100 instance or RTX 4090: 50 epochs ≈ 5-15 minutes
at v1 scale per brief §5.5 estimate.

## MLflow

Optional. Set `MLFLOW_TRACKING_URI` to log run metrics +
hyperparameters + artifacts. Without it, training runs are
ephemeral — only the embeddings.json file persists.

## Retraining cadence

Per brief §5.4 — weekly during initial deployment, monthly once
embedding quality is validated. Re-running with the same
`--model-version` overwrites the existing rows in
`entity_embeddings` (ON CONFLICT DO UPDATE). Bumping the version
keeps both versions live, useful for A/B comparison.

## What's NOT yet here (per brief sequencing)

- Trigger.dev wrapper for scheduled retraining (gated on the
  v3→v4 migration that's blocking the Apollo cron)
- Inductive inference for new entities (Component B days 11-13)
- Two-tower retrieval model (Component C)
- Entity resolution layer (Component D)
