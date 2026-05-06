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


def split_train_val_edges(
    graph: ProcurGraph, val_fraction: float = 0.1, seed: int = 42
) -> dict[tuple[str, str, str], torch.Tensor]:
    """Mask out a held-out validation set per edge type.

    Mutates graph.data so message passing during training only sees
    train edges — preserves the inductive contract (the model never
    sees val edges, so a high val AUC is real generalization, not
    leakage).

    Returns the held-out val edges keyed by edge type. Reverse edge
    types ('rev_*') are skipped — they're auto-added by ToUndirected
    and would leak the masked val edges back through.

    Per brief §5.6: "Validation against held-out edges". 10% is the
    standard split for link prediction at this scale.
    """
    g = torch.Generator().manual_seed(seed)
    val_edges: dict[tuple[str, str, str], torch.Tensor] = {}
    data = graph.data

    primary_types = [et for et in data.edge_types if not et[1].startswith("rev_")]
    for edge_type in primary_types:
        edge_index = data[edge_type].edge_index
        n = edge_index.size(1)
        if n < 20:
            # Too few edges to split meaningfully — keep all for training.
            val_edges[edge_type] = torch.zeros((2, 0), dtype=torch.long)
            continue
        n_val = max(1, int(n * val_fraction))
        perm = torch.randperm(n, generator=g)
        val_idx = perm[:n_val]
        train_idx = perm[n_val:]
        val_edges[edge_type] = edge_index[:, val_idx].contiguous()
        data[edge_type].edge_index = edge_index[:, train_idx].contiguous()
        # Also mirror to the reverse edge type so ToUndirected stays consistent.
        rev_key = (edge_type[2], f"rev_{edge_type[1]}", edge_type[0])
        if rev_key in data.edge_types:
            rev_edge_index = data[rev_key].edge_index
            # Reverse edges share the index ordering with the primary
            # type when ToUndirected emits them — we slice by the same
            # train_idx to keep them aligned.
            if rev_edge_index.size(1) == n:
                data[rev_key].edge_index = rev_edge_index[:, train_idx].contiguous()
    return val_edges


def _roc_auc(scores: torch.Tensor, targets: torch.Tensor) -> float:
    """Compute binary ROC-AUC via the rank-based formula. Avoids a
    sklearn dependency at training time."""
    if scores.numel() == 0:
        return 0.0
    order = torch.argsort(scores)
    ranks = torch.empty_like(order, dtype=torch.float)
    ranks[order] = torch.arange(1, scores.size(0) + 1, dtype=torch.float, device=scores.device)
    pos_mask = targets > 0.5
    n_pos = int(pos_mask.sum().item())
    n_neg = int((~pos_mask).sum().item())
    if n_pos == 0 or n_neg == 0:
        return 0.0
    # AUC = (sum_of_pos_ranks - n_pos*(n_pos+1)/2) / (n_pos * n_neg)
    sum_pos = float(ranks[pos_mask].sum().item())
    return (sum_pos - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


@torch.no_grad()
def compute_val_metrics(
    model: HeterogeneousGraphSAGE,
    graph: ProcurGraph,
    val_edges: dict[tuple[str, str, str], torch.Tensor],
    *,
    num_neg_per_pos: int = 5,
) -> dict[str, float]:
    """Held-out link-prediction AUC, per edge type + macro average.

    Uses the train-only graph for message passing — val edges are
    not visible — so a high score genuinely reflects generalization.
    """
    model.eval()
    data = graph.data
    embeddings = model(
        {nt: data[nt].x for nt in graph.node_ids},
        {et: data[et].edge_index for et in data.edge_types},
    )

    metrics: dict[str, float] = {}
    aucs: list[float] = []
    for edge_type, val_edge_index in val_edges.items():
        if val_edge_index.size(1) == 0:
            continue
        src_type, rel, dst_type = edge_type
        src_emb = embeddings[src_type]
        dst_emb = embeddings[dst_type]
        if src_emb.size(0) == 0 or dst_emb.size(0) == 0:
            continue

        val_edge_index = val_edge_index.to(src_emb.device)
        pos_score = link_score(src_emb[val_edge_index[0]], dst_emb[val_edge_index[1]])
        neg_index = negative_sample_edges(
            val_edge_index,
            num_src=src_emb.size(0),
            num_dst=dst_emb.size(0),
            num_neg_per_pos=num_neg_per_pos,
        ).to(src_emb.device)
        neg_score = link_score(src_emb[neg_index[0]], dst_emb[neg_index[1]])

        scores = torch.cat([pos_score, neg_score])
        targets = torch.cat([torch.ones_like(pos_score), torch.zeros_like(neg_score)])
        auc = _roc_auc(scores, targets)
        metrics[f"val_auc/{src_type}-{rel}-{dst_type}"] = auc
        aucs.append(auc)

    metrics["val_auc/macro"] = sum(aucs) / len(aucs) if aucs else 0.0
    return metrics


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


def _save_checkpoint(
    checkpoint_dir: Path,
    model: HeterogeneousGraphSAGE,
    feat_dims: dict[str, int],
    edge_types: list[tuple[str, str, str]],
    *,
    hidden_dim: int,
    out_dim: int,
    model_version: str,
    trained_at: dt.datetime,
) -> None:
    """Persist the trained model + meta for inductive inference.

    Inductive flow (procur_ml.embed_entity) reloads the same module
    architecture from feature_dims + edge_types, then calls
    load_state_dict on model.pt. Keep both files together; bump both
    when retraining changes shape.
    """
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), checkpoint_dir / "model.pt")
    meta = {
        "modelVersion": model_version,
        "trainedAt": trained_at.isoformat(),
        "featureDims": feat_dims,
        "edgeTypes": [list(et) for et in edge_types],
        "hiddenDim": hidden_dim,
        "outDim": out_dim,
    }
    (checkpoint_dir / "model_meta.json").write_text(json.dumps(meta))


@click.command()
@click.option("--graph", type=click.Path(exists=True, dir_okay=False, path_type=Path), required=True)
@click.option("--output", type=click.Path(dir_okay=False, path_type=Path), default="embeddings.json")
@click.option(
    "--checkpoint-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default="checkpoints",
    help="Where to save model.pt + model_meta.json for later inductive inference (procur_ml.embed_entity).",
)
@click.option("--epochs", type=int, default=50)
@click.option("--lr", type=float, default=0.005)
@click.option("--hidden-dim", type=int, default=128)
@click.option("--out-dim", type=int, default=128)
@click.option("--num-neg-per-pos", type=int, default=5, help="Negative samples per positive edge")
@click.option(
    "--val-fraction",
    type=float,
    default=0.1,
    help="Fraction of edges held out for validation. 0 disables validation entirely.",
)
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
    checkpoint_dir: Path,
    epochs: int,
    lr: float,
    hidden_dim: int,
    out_dim: int,
    num_neg_per_pos: int,
    val_fraction: float,
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
    # Hold out a validation edge set BEFORE moving to GPU; mutates
    # graph.data so message passing sees only train edges.
    val_edges = split_train_val_edges(procur_graph, val_fraction=val_fraction, seed=seed)
    data = procur_graph.data.to(device)
    val_edges = {et: ei.to(device) for et, ei in val_edges.items()}

    held_out_count = sum(int(ei.size(1)) for ei in val_edges.values())
    logger.info(
        "loaded graph: nodes=%s edges=%s, held_out=%d for val",
        procur_graph.metadata["nodeCounts"],
        procur_graph.metadata["edgeCounts"],
        held_out_count,
    )

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
                "val_fraction": val_fraction,
                "seed": seed,
                "node_counts": procur_graph.metadata["nodeCounts"],
                "edge_counts": procur_graph.metadata["edgeCounts"],
                "val_held_out": held_out_count,
            }
        )

    # Track best-val checkpoint — saved separately at checkpoints/best/
    # so the inductive-inference path can use the most-generalizing
    # weights rather than the final-epoch weights (which can overfit).
    best_val_auc = -1.0
    best_epoch = 0

    for epoch in range(1, epochs + 1):
        losses = train_step(model, procur_graph, optimizer, num_neg_per_pos=num_neg_per_pos)
        val_metrics = compute_val_metrics(
            model,
            procur_graph,
            val_edges,
            num_neg_per_pos=num_neg_per_pos,
        )
        macro_val_auc = val_metrics.get("val_auc/macro", 0.0)

        if epoch % 5 == 0 or epoch == 1:
            logger.info(
                "epoch=%d loss=%.4f val_auc_macro=%.4f", epoch, losses["total_loss"], macro_val_auc
            )

        if macro_val_auc > best_val_auc:
            best_val_auc = macro_val_auc
            best_epoch = epoch
            _save_checkpoint(
                checkpoint_dir / "best",
                model,
                feature_dims(procur_graph),
                edge_types,
                hidden_dim=hidden_dim,
                out_dim=out_dim,
                model_version=model_version,
                trained_at=trained_at,
            )

        if mlflow_run is not None:
            import mlflow  # type: ignore[import-untyped]

            payload: dict[str, float] = {}
            for k, v in losses.items():
                if isinstance(v, float):
                    payload[k] = v
            payload.update({k: float(v) for k, v in val_metrics.items()})
            payload["best_val_auc"] = best_val_auc
            mlflow.log_metrics(payload, step=epoch)

    logger.info(
        "best val_auc_macro=%.4f at epoch %d (saved to %s/best/)",
        best_val_auc,
        best_epoch,
        checkpoint_dir,
    )

    embeddings = compute_final_embeddings(model, procur_graph)
    write_embeddings_json(
        output,
        procur_graph,
        embeddings,
        model_version=model_version,
        trained_at=trained_at,
    )
    logger.info("wrote %s", output)

    # Save checkpoint + meta for procur_ml.embed_entity (inductive
    # inference, brief days 11-13). Without these files, new entities
    # entering known_entities can't be embedded without a full retrain.
    _save_checkpoint(
        checkpoint_dir,
        model,
        feature_dims(procur_graph),
        edge_types,
        hidden_dim=hidden_dim,
        out_dim=out_dim,
        model_version=model_version,
        trained_at=trained_at,
    )
    logger.info("saved checkpoint to %s/", checkpoint_dir)

    if mlflow_run is not None:
        import mlflow  # type: ignore[import-untyped]

        mlflow.log_artifact(str(output))
        mlflow.log_artifact(str(checkpoint_dir / "model.pt"))
        mlflow.log_artifact(str(checkpoint_dir / "model_meta.json"))
        mlflow.end_run()


if __name__ == "__main__":
    main()
