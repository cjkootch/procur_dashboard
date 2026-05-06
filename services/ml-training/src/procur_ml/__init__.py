"""procur ML training pipeline.

Component B per docs/procur-ml-layer-brief.md §5. Trains heterogeneous
GraphSAGE embeddings over procur's data graph + writes them back to
the entity_embeddings + signal_embeddings tables (schema shipped in
Component A — PR #419).

Stage gate from extract-graph (#422) → train → upsert:

    1. pnpm --filter @procur/db extract-graph --output graph.json
    2. python -m procur_ml.train --graph graph.json --output embeddings.json
    3. python -m procur_ml.upsert --embeddings embeddings.json
"""

__version__ = "0.0.0"
