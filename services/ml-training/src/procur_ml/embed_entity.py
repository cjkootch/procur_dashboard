"""Inductive embedding for new / updated entities — Component B days 11-13.

Per docs/procur-ml-layer-brief.md §5.4. GraphSAGE's killer feature is
that new nodes can be embedded without retraining. When a new entity
lands in known_entities (via news ingestion, customs scrape, manual
seed, etc.), this script:

    1. Extracts the entity's 1-hop neighborhood from procur Postgres
       via `pnpm extract-graph --single-entity=<slug>`. <1s at scale.
    2. Loads the trained checkpoint from training (model.pt +
       model_meta.json).
    3. Forward-passes the small subgraph through the trained model.
    4. Picks out the target entity's embedding by slug index.
    5. Upserts into entity_embeddings.

Compared to retraining (~minutes-hours), this is sub-second per
entity. Runs on CPU; no GPU required at inference time.

Workflow:

    # 1. Extract subgraph for new entity (TS side, <1s)
    pnpm --filter @procur/db extract-graph \\
        --single-entity=fuel-buyer:new-supplier --output single.json

    # 2. Inductively embed + upsert
    python -m procur_ml.embed_entity \\
        --graph single.json --checkpoint-dir checkpoints --upsert
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import click
import psycopg
import torch
from dotenv import load_dotenv

from .dataset import load_graph
from .model import HeterogeneousGraphSAGE
from .upsert import _vector_literal

logger = logging.getLogger("procur_ml.embed_entity")


def _load_model(checkpoint_dir: Path) -> tuple[HeterogeneousGraphSAGE, dict]:
    """Reconstruct the trained module from saved meta + state dict.

    The architecture must match training exactly — feature_dims,
    edge_types, hidden_dim, out_dim. model_meta.json captures all
    of that; bumping any of them at training time produces a fresh
    checkpoint that this loader picks up automatically.
    """
    meta = json.loads((checkpoint_dir / "model_meta.json").read_text())
    feat_dims = {nt: int(d) for nt, d in meta["featureDims"].items()}
    edge_types = [tuple(et) for et in meta["edgeTypes"]]
    model = HeterogeneousGraphSAGE(
        feature_dims=feat_dims,
        hidden_dim=int(meta["hiddenDim"]),
        out_dim=int(meta["outDim"]),
        edge_types=edge_types,
    )
    state = torch.load(checkpoint_dir / "model.pt", map_location="cpu", weights_only=True)
    model.load_state_dict(state)
    model.eval()
    return model, meta


@torch.no_grad()
def _compute_embedding_for_target(
    model: HeterogeneousGraphSAGE,
    graph,
    target_slug: str,
) -> tuple[str, torch.Tensor]:
    """Forward-pass the loaded subgraph through the trained model and
    extract the target entity's 128-dim row.

    The subgraph already includes the target + its 1-hop neighborhood,
    so message passing produces a high-quality embedding. The other
    nodes' embeddings are discarded — they'd be lower-quality
    re-computations of nodes that already have rows in
    entity_embeddings via the periodic full retrain.
    """
    data = graph.data
    embeddings = model(
        {nt: data[nt].x for nt in graph.node_ids},
        {et: data[et].edge_index for et in data.edge_types},
    )
    entity_ids = graph.node_ids["entity"]
    if target_slug not in entity_ids:
        raise ValueError(
            f"target slug {target_slug!r} not in entity nodes — "
            "is the subgraph extract for the wrong slug?"
        )
    idx = entity_ids.index(target_slug)
    return target_slug, embeddings["entity"][idx].cpu()


def _upsert_single(
    conn: psycopg.Connection,
    slug: str,
    vector: torch.Tensor,
    *,
    embedding_kind: str,
    model_version: str,
    trained_at: str,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO entity_embeddings (
                entity_slug, embedding_kind, embedding, embedding_dim,
                model_version, trained_at
            ) VALUES (%s, %s, %s::vector, %s, %s, %s::timestamp)
            ON CONFLICT (entity_slug, embedding_kind, model_version)
            DO UPDATE SET
                embedding = EXCLUDED.embedding,
                trained_at = EXCLUDED.trained_at;
            """,
            (
                slug,
                embedding_kind,
                _vector_literal(vector.tolist()),
                vector.size(0),
                model_version,
                trained_at,
            ),
        )
    conn.commit()


@click.command()
@click.option(
    "--graph",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="Subgraph JSON from `extract-graph --single-entity=<slug>`.",
)
@click.option(
    "--checkpoint-dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default="checkpoints",
)
@click.option(
    "--slug",
    type=str,
    default=None,
    help="Target entity slug. Defaults to the subgraph's metadata.targetEntitySlug.",
)
@click.option(
    "--kind",
    type=str,
    default="graph_v1",
    help="entity_embeddings.embedding_kind. Default 'graph_v1'.",
)
@click.option("--upsert/--no-upsert", default=False, help="Write to Postgres (--upsert) or print only (default).")
@click.option(
    "--database-url",
    type=str,
    default=None,
    envvar="DATABASE_URL",
    help="Postgres URL. Falls back to DATABASE_URL.",
)
def main(
    graph: Path,
    checkpoint_dir: Path,
    slug: str | None,
    kind: str,
    upsert: bool,
    database_url: str | None,
) -> None:
    """Inductively embed a single entity using a trained checkpoint."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    load_dotenv(dotenv_path=Path("../../.env.local"))
    load_dotenv(dotenv_path=Path("../../.env"))

    procur_graph = load_graph(graph, undirected=True)
    target_slug = slug or procur_graph.metadata.get("targetEntitySlug")
    if not target_slug:
        raise click.ClickException(
            "no target slug — pass --slug or extract the subgraph with "
            "extract-graph --single-entity=<slug>",
        )

    model, meta = _load_model(checkpoint_dir)
    logger.info(
        "loaded checkpoint model_version=%s trained_at=%s",
        meta["modelVersion"],
        meta["trainedAt"],
    )

    target, embedding = _compute_embedding_for_target(model, procur_graph, target_slug)
    norm = float(embedding.norm())
    logger.info("computed embedding for %s — dim=%d, norm=%.3f", target, embedding.size(0), norm)

    if not upsert:
        click.echo(json.dumps({"slug": target, "vector": embedding.tolist()}))
        return

    if database_url is None:
        database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise click.ClickException("DATABASE_URL not set")

    with psycopg.connect(database_url) as conn:
        _upsert_single(
            conn,
            target,
            embedding,
            embedding_kind=kind,
            model_version=str(meta["modelVersion"]),
            trained_at=str(meta["trainedAt"]),
        )
    logger.info("upserted %s into entity_embeddings (kind=%s)", target, kind)


if __name__ == "__main__":
    main()
