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

Optional, opt-in extra:

```sh
pip install -e ".[mlflow]"
```

Then set `MLFLOW_TRACKING_URI` to log run metrics + hyperparameters
+ artifacts. Without it, training runs are ephemeral — only the
embeddings.json file persists. mlflow drags in pyarrow + sqlalchemy
which need a C++ toolchain to build on macOS, so it's not part of
the base install.

## Retraining cadence

Per brief §5.4 — weekly during initial deployment, monthly once
embedding quality is validated. Re-running with the same
`--model-version` overwrites the existing rows in
`entity_embeddings` (ON CONFLICT DO UPDATE). Bumping the version
keeps both versions live, useful for A/B comparison.

## Validation

Brief §5.6 — two layers of validation gate the trained model.

### Held-out edge AUC (during training)

`procur_ml.train` automatically holds out 10% of edges per type as
a validation set. The model never sees these during message passing,
so per-epoch `val_auc/macro` is real generalization. The
best-val-AUC checkpoint lands at `checkpoints/best/` separately
from the final-epoch checkpoint at `checkpoints/`.

```sh
python -m procur_ml.train --graph graph.json --val-fraction 0.1
# logs each epoch:
#   epoch=10 loss=0.4231 val_auc_macro=0.7842
#   epoch=20 loss=0.3104 val_auc_macro=0.8156
# logged to MLflow when MLFLOW_TRACKING_URI is set
```

### Qualitative similarity sanity-check

`procur_ml.validate` runs hand-curated peer pairs through the
trained model and verifies that known-peer pairs cluster while
known-non-peer pairs don't. Cases are in
`tests/qualitative_pairs.json` — analyst-curated; extend as the
rolodex grows.

```sh
python -m procur_ml.validate \
    --graph graph.json \
    --checkpoint-dir checkpoints/best \
    --pairs tests/qualitative_pairs.json
```

Exit status reflects pass/fail. Suitable for CI gating before
shipping a new model_version to production.

## Inductive inference for new entities

When a new entity lands in `known_entities` between retraining
cycles (news ingestion, customs scrape, manual seed), embed it
inductively without retraining. Sub-second per entity on CPU.

```sh
# 1. Extract the entity's 1-hop neighborhood (TS side, <1s)
cd packages/db
pnpm run extract-graph \
    --single-entity=fuel-buyer:new-supplier \
    --output ../../single.json

# 2. Inductively embed + upsert
cd ../../services/ml-training
python -m procur_ml.embed_entity \
    --graph ../../single.json \
    --checkpoint-dir checkpoints \
    --upsert
```

The `--single-entity` flag on `extract-graph` constrains the
graph to the target + 1-hop neighborhood across all node types,
trimming the ~5-min trgm-match cost for ownership edges down to
~1s. The Python side reloads the trained model from
`checkpoints/model.pt` + `checkpoints/model_meta.json` (saved
automatically by `procur_ml.train`), forward-passes the small
subgraph, and upserts only the target's row.

## What's NOT yet here (per brief sequencing)

- Trigger.dev wrapper for scheduled retraining (gated on the
  v3→v4 migration that's blocking the Apollo cron)
- Two-tower retrieval model (Component C — gated on match-outcome
  data volume per brief §12.2)
