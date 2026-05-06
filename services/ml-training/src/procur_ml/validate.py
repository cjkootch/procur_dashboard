"""Qualitative similarity sanity-check — Component B days 14-15.

Per docs/procur-ml-layer-brief.md §5.6. Loads a trained checkpoint
+ the full graph + a hand-curated peer-pairs file, and checks that
the trained embeddings rank known peers above known non-peers.

This is the gate for "training looks reasonable" before shipping
embeddings to production. The held-out edge AUC during train.py
catches obvious failure modes (loss not decreasing, model not
generalizing); this script catches the subtler "does the model
understand commercial peer relationships" question that matters
for chat-tool quality.

Run:
    python -m procur_ml.validate \\
        --graph graph.json \\
        --checkpoint-dir checkpoints/best \\
        --pairs tests/qualitative_pairs.json
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import click
import torch
import torch.nn.functional as F

from .dataset import load_graph
from .embed_entity import _load_model

logger = logging.getLogger("procur_ml.validate")

DEFAULT_PAIRS_PATH = Path(__file__).parent.parent.parent / "tests" / "qualitative_pairs.json"


def cosine(a: torch.Tensor, b: torch.Tensor) -> float:
    """Cosine similarity between two vectors, in [-1, 1]."""
    return float(F.cosine_similarity(a.unsqueeze(0), b.unsqueeze(0)).item())


@click.command()
@click.option(
    "--graph",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="Full graph JSON (procur_ml.train output, not single-entity).",
)
@click.option(
    "--checkpoint-dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default="checkpoints/best",
    help="Trained model directory. Defaults to the best-val-AUC checkpoint.",
)
@click.option(
    "--pairs",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    default=str(DEFAULT_PAIRS_PATH),
    help="JSON file of hand-curated peer-pair sanity checks.",
)
@click.option(
    "--threshold-high",
    type=float,
    default=0.5,
    help="Cosine similarity floor for 'high' expected pairs. Below this = fail.",
)
@click.option(
    "--threshold-low",
    type=float,
    default=0.3,
    help="Cosine similarity ceiling for 'low' expected pairs. Above this = fail.",
)
def main(
    graph: Path,
    checkpoint_dir: Path,
    pairs: Path,
    threshold_high: float,
    threshold_low: float,
) -> None:
    """Run qualitative similarity sanity-checks on a trained model."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    procur_graph = load_graph(graph, undirected=True)
    model, meta = _load_model(checkpoint_dir)
    logger.info(
        "loaded checkpoint model_version=%s trained_at=%s",
        meta["modelVersion"],
        meta["trainedAt"],
    )

    # Forward-pass once — we only need the entity embeddings for the
    # qualitative checks. Non-entity nodes are out of scope here.
    with torch.no_grad():
        data = procur_graph.data
        embeddings = model(
            {nt: data[nt].x for nt in procur_graph.node_ids},
            {et: data[et].edge_index for et in data.edge_types},
        )
    entity_emb = embeddings.get("entity")
    if entity_emb is None or entity_emb.size(0) == 0:
        raise click.ClickException("model produced no entity embeddings — check graph + checkpoint")

    entity_ids: list[str] = procur_graph.node_ids["entity"]
    slug_to_idx = {slug: i for i, slug in enumerate(entity_ids)}

    pair_set = json.loads(Path(pairs).read_text())
    cases = pair_set.get("cases", [])
    logger.info("loaded %d qualitative cases from %s", len(cases), pairs)

    passed = 0
    failed = 0
    skipped = 0
    failures: list[str] = []
    rows: list[dict[str, object]] = []

    for case in cases:
        a = case["a"]
        b = case["b"]
        expected = case["expected"]
        note = case.get("note", "")

        ai = slug_to_idx.get(a)
        bi = slug_to_idx.get(b)
        if ai is None or bi is None:
            skipped += 1
            logger.warning("skip %s ↔ %s — not in graph", a, b)
            continue

        sim = cosine(entity_emb[ai], entity_emb[bi])
        ok = (
            (expected == "high" and sim >= threshold_high)
            or (expected == "low" and sim <= threshold_low)
            or (expected == "any")
        )
        rows.append(
            {
                "a": a,
                "b": b,
                "expected": expected,
                "similarity": round(sim, 4),
                "passed": ok,
                "note": note,
            }
        )
        if ok:
            passed += 1
        else:
            failed += 1
            failures.append(
                f"  ✗ {a} ↔ {b}  expected={expected}  sim={sim:.3f}  ({note})"
            )

    print()
    print(f"Qualitative similarity sanity-check — {passed} passed, {failed} failed, {skipped} skipped")
    print(f"  thresholds: high≥{threshold_high}, low≤{threshold_low}")
    if failures:
        print("\nFailures:")
        for line in failures:
            print(line)

    print("\nFull results:")
    for r in rows:
        mark = "✓" if r["passed"] else "✗"
        print(f"  {mark} {r['a']:50}{r['b']:50}  exp={r['expected']:5}  sim={r['similarity']:.3f}")

    if failed > 0:
        raise click.ClickException(f"{failed} qualitative checks failed")


if __name__ == "__main__":
    main()
