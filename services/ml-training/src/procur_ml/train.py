"""GraphSAGE training entry point.

Runs link-prediction training over all extracted edge types using
random negative sampling (brief §5.4). Outputs:
    1. embeddings.json — per-node-type embeddings keyed by slug/mmsi,
       ready for the upsert step
    2. mlruns/<run-id>/ — MLflow tracking directory with metrics +
       hyperparameters + the trained checkpoint

Training is single-GPU. Procur scale (~10K total nodes) fits on any
modern card; for larger graphs swap to a NeighborLoader-based
training loop. Brief §5.5 estimates 2-8 hours for full training at
procur's likely v1 scale.

Run:
    python -m procur_ml.train --graph graph.json --output embeddings.json
    python -m procur_ml.train --graph graph.json --epochs 200 --hidden-dim 256
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import random
from pathlib import Path

import click
import torch
import torch.nn.functional as F
from torch.optim import Adam

from .dataset import ProcurGraph, feature_dims, load_graph
from .model import HeterogeneousGraphSAGE, link_score

logger = logging.getLogger("procur_ml.train")


def negative_sample_edges(
    edge_index: torch.Tensor,
    num_src: int,
    num_dst: int,
    num_neg_per_pos: int = 5,
) -> torch.Tensor:
    """Generate random negative edges via uniform sampling.

    Brief §10 calls out negative-sampling strategy as deferred-to-
    implementation. We start with uniform random (simplest); brief
    flags hard-negative mining as a follow-up if validation shows
    bias toward easy candidates.

    Returns edge_index of shape (2, num_pos * num_neg_per_pos).
    """
    num_pos = edge_index.size(1)
    if num_pos == 0:
        return torch.zeros((2, 0), dtype=torch.long)
    num_neg = num_pos * num_neg_per_pos
    src = torch.randint(0, num_src, (num_neg,))
    dst = torch.randint(0, num_dst, (num_neg,))
    return torch.stack([src, dst])


def train_step(
    model: HeterogeneousGraphSAGE,
    graph: ProcurGraph,
    optimizer: Adam,
    *,
    num_neg_per_pos: int,
) -> dict[str, float]:
    """One full training epoch — pass over every edge type."""
    model.train()
    optimizer.zero_grad()

    data = graph.data
    embeddings = model(
        {nt: data[nt].x for nt in graph.node_ids},
        {et: data[et].edge_index for et in data.edge_types},
    )

    losses: dict[str, float] = {}
    total_loss = torch.tensor(0.0, device=next(model.parameters()).device)
    n_terms = 0

    # Skip auto-added reverse edge types — they're symmetric of the
    # primary edges and would double-count the training signal.
    for edge_type in data.edge_types:
        rel = edge_type[1]
        if rel.startswith("rev_"):
            continue

        edge_index = data[edge_type].edge_index
        if edge_index.size(1) == 0:
            continue

        src_type, _, dst_type = edge_type
        src_emb_all = embeddings[src_type]
        dst_emb_all = embeddings[dst_type]
        if src_emb_all.size(0) == 0 or dst_emb_all.size(0) == 0:
            continue

        # Positive scores
        pos_src = src_emb_all[edge_index[0]]
        pos_dst = dst_emb_all[edge_index[1]]
        pos_score = link_score(pos_src, pos_dst)

        # Negative scores via random sampling
        neg_index = negative_sample_edges(
            edge_index,
            num_src=src_emb_all.size(0),
            num_dst=dst_emb_all.size(0),
            num_neg_per_pos=num_neg_per_pos,
        ).to(edge_index.device)
        neg_src = src_emb_all[neg_index[0]]
        neg_dst = dst_emb_all[neg_index[1]]
        neg_score = link_score(neg_src, neg_dst)

        # BCE-with-logits loss — pos targets 1, neg targets 0.
        scores = torch.cat([pos_score, neg_score])
        targets = torch.cat(
            [
                torch.ones_like(pos_score),
                torch.zeros_like(neg_score),
            ]
        )
        loss = F.binary_cross_entropy_with_logits(scores, targets)
        losses[f"{src_type}-{rel}-{dst_type}"] = loss.item()
        total_loss = total_loss + loss
        n_terms += 1

    if n_terms == 0:
        return {"total_loss": 0.0, "per_edge": losses}

    total_loss = total_loss / n_terms
    total_loss.backward()
    optimizer.step()
    losses["total_loss"] = total_loss.item()
    return losses


@torch.no_grad()
def compute_final_embeddings(
    model: HeterogeneousGraphSAGE, graph: ProcurGraph
) -> dict[str, torch.Tensor]:
    model.eval()
    data = graph.data
    return model(
        {nt: data[nt].x for nt in graph.node_ids},
        {et: data[et].edge_index for et in data.edge_types},
    )


def write_embeddings_json(
    output: Path,
    graph: ProcurGraph,
    embeddings: dict[str, torch.Tensor],
    *,
    model_version: str,
    trained_at: dt.datetime,
) -> None:
    """Serialize embeddings to JSON. Schema matches what upsert.py
    consumes — keep in sync if either side changes."""
    payload = {
        "metadata": {
            "modelVersion": model_version,
            "trainedAt": trained_at.isoformat(),
            "embeddingDim": embeddings[next(iter(embeddings))].size(1),
            "extractedAt": graph.metadata["extractedAt"],
        },
        "embeddings": {
            node_type: [
                {
                    "id": node_id,
                    "vector": emb.tolist(),
                }
                for node_id, emb in zip(
                    graph.node_ids[node_type],
                    embeddings[node_type].cpu(),
                    strict=True,
                )
            ]
            for node_type in graph.node_ids
            if node_type in embeddings and embeddings[node_type].size(0) > 0
        },
    }
    output.write_text(json.dumps(payload))


def _maybe_setup_mlflow(run_name: str) -> object | None:
    """Returns an MLflow active-run context if MLFLOW_TRACKING_URI is
    set, else None. Keeps the script useful in dev without requiring
    a tracking server."""
    try:
        import mlflow  # type: ignore[import-untyped]
    except ImportError:
        return None
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI")
    if not tracking_uri:
        return None
    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_experiment("procur-graphsage")
    return mlflow.start_run(run_name=run_name)


@click.command()
@click.option("--graph", type=click.Path(exists=True, dir_okay=False, path_type=Path), required=True)
@click.option("--output", type=click.Path(dir_okay=False, path_type=Path), default="embeddings.json")
@click.option("--epochs", type=int, default=50)
@click.option("--lr", type=float, default=0.005)
@click.option("--hidden-dim", type=int, default=128)
@click.option("--out-dim", type=int, default=128)
@click.option("--num-neg-per-pos", type=int, default=5, help="Negative samples per positive edge")
@click.option("--seed", type=int, default=42)
@click.option(
    "--model-version",
    type=str,
    default=None,
    help="Identifier for entity_embeddings.model_version. Auto-generated when omitted.",
)
@click.option("--device", type=str, default=None, help="cuda | cpu (auto-detected when omitted)")
def main(
    graph: Path,
    output: Path,
    epochs: int,
    lr: float,
    hidden_dim: int,
    out_dim: int,
    num_neg_per_pos: int,
    seed: int,
    model_version: str | None,
    device: str | None,
) -> None:
    """Train heterogeneous GraphSAGE over the procur graph."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    random.seed(seed)
    torch.manual_seed(seed)

    if device is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    logger.info("device=%s", device)

    procur_graph = load_graph(graph, undirected=True)
    data = procur_graph.data.to(device)

    logger.info("loaded graph: nodes=%s edges=%s", procur_graph.metadata["nodeCounts"], procur_graph.metadata["edgeCounts"])

    edge_types = list(data.edge_types)
    model = HeterogeneousGraphSAGE(
        feature_dims=feature_dims(procur_graph),
        hidden_dim=hidden_dim,
        out_dim=out_dim,
        edge_types=edge_types,
    ).to(device)
    optimizer = Adam(model.parameters(), lr=lr)

    if model_version is None:
        ts = dt.datetime.now(dt.UTC).strftime("%Y_%m_%d_%H%M%S")
        model_version = f"graphsage_{ts}_v1"
    trained_at = dt.datetime.now(dt.UTC)

    run_name = model_version
    mlflow_run = _maybe_setup_mlflow(run_name)
    if mlflow_run is not None:
        import mlflow  # type: ignore[import-untyped]

        mlflow.log_params(
            {
                "epochs": epochs,
                "lr": lr,
                "hidden_dim": hidden_dim,
                "out_dim": out_dim,
                "num_neg_per_pos": num_neg_per_pos,
                "seed": seed,
                "node_counts": procur_graph.metadata["nodeCounts"],
                "edge_counts": procur_graph.metadata["edgeCounts"],
            }
        )

    for epoch in range(1, epochs + 1):
        losses = train_step(model, procur_graph, optimizer, num_neg_per_pos=num_neg_per_pos)
        if epoch % 5 == 0 or epoch == 1:
            logger.info("epoch=%d loss=%.4f", epoch, losses["total_loss"])
        if mlflow_run is not None:
            import mlflow  # type: ignore[import-untyped]

            mlflow.log_metrics({k: v for k, v in losses.items() if isinstance(v, float)}, step=epoch)

    embeddings = compute_final_embeddings(model, procur_graph)
    write_embeddings_json(
        output,
        procur_graph,
        embeddings,
        model_version=model_version,
        trained_at=trained_at,
    )
    logger.info("wrote %s", output)
    if mlflow_run is not None:
        import mlflow  # type: ignore[import-untyped]

        mlflow.log_artifact(str(output))
        mlflow.end_run()


if __name__ == "__main__":
    main()
