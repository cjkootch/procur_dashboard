"""BGE-reranker-v2-m3 — cross-encoder reranking for procur's
recommendation pipeline.

Cross-encoder vs the bi-encoder bge_m3 module:
  * bge_m3 (bi-encoder)  — embed query + passage independently, cosine.
    Cheap, recall-friendly. Indexed in pgvector.
  * bge_reranker (cross) — joint attention over (query, passage), gives
    a relevance score. Expensive (~10-50ms per pair on CPU), precision-
    friendly. Used as a SECOND stage on top of bi-encoder retrieval.

Workflow (offline batch path, mirrors bge_m3.py's CLI shape):

  python -m procur_ml.bge_reranker rerank \\
      --input pairs.json \\
      --output scored.json

  pairs.json:
    [
      {"id": "p1", "query": "ULSD cargo Cartagena", "passage": "..."},
      ...
    ]
  scored.json:
    [
      {"id": "p1", "query": "...", "passage": "...", "score": 0.873, "model_version": "bge-reranker-v2-m3"},
      ...
    ]

The catalog `rerankPassages` helper hits the HF Inference API for
online reranking. This CLI is the offline / self-hosted path —
faster, no rate limit, but requires running locally.

Behind the optional [bge] extra alongside bge_m3:
    uv pip install -e .[bge]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import click


def _load(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise click.BadParameter(f"{path} must contain a JSON array of records")
    return data


def _validate(record: dict[str, Any]) -> None:
    required = ("id", "query", "passage")
    missing = [k for k in required if k not in record]
    if missing:
        raise click.BadParameter(
            f"record missing required fields: {missing} (got {sorted(record.keys())})"
        )
    if not isinstance(record["passage"], str) or not record["passage"].strip():
        raise click.BadParameter(
            f"record {record['id']} has empty passage — filter these upstream"
        )


@click.group()
def main() -> None:
    """BGE-reranker-v2-m3 cross-encoder for procur."""


@main.command()
@click.option(
    "--input",
    "input_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="JSON array of {id, query, passage} records.",
)
@click.option(
    "--output",
    "output_path",
    type=click.Path(dir_okay=False, path_type=Path),
    required=True,
    help="Where to write scored records (same shape, +score, +model_version).",
)
@click.option(
    "--batch-size",
    type=int,
    default=16,
    show_default=True,
    help="Pairs per cross-encoder forward pass.",
)
@click.option(
    "--device",
    default=None,
    help="torch device override ('cuda' / 'mps' / 'cpu'). Auto-detects when omitted.",
)
@click.option(
    "--max-length",
    type=int,
    default=8192,
    show_default=True,
    help="Reranker max sequence length (BGE-reranker-v2-m3 supports up to 8192).",
)
def rerank(
    input_path: Path,
    output_path: Path,
    batch_size: int,
    device: str | None,
    max_length: int,
) -> None:
    """Score every (query, passage) pair from --input."""
    try:
        from sentence_transformers import CrossEncoder
    except ImportError as exc:
        raise click.ClickException(
            "sentence-transformers not installed. Install with `pip install -e '.[bge]'`."
        ) from exc

    records = _load(input_path)
    for r in records:
        _validate(r)
    if not records:
        click.echo("(no records to score)")
        output_path.write_text("[]", encoding="utf-8")
        return

    click.echo(
        f"loading BAAI/bge-reranker-v2-m3 (device={device or 'auto'})",
        err=True,
    )
    model = CrossEncoder(
        "BAAI/bge-reranker-v2-m3",
        device=device,
        max_length=max_length,
    )

    pairs = [(r["query"], r["passage"]) for r in records]
    total = len(pairs)
    click.echo(f"scoring {total} pairs (batch_size={batch_size})", err=True)

    # CrossEncoder.predict returns logits in (-inf, +inf). Apply
    # sigmoid via activation_fct so callers see a normalized [0, 1]
    # relevance score, matching what FlagReranker(normalize=True)
    # would have returned.
    import torch

    raw_scores = model.predict(
        pairs,
        batch_size=batch_size,
        activation_fct=torch.nn.Sigmoid(),
        show_progress_bar=False,
    )
    scores_list = (
        raw_scores.tolist() if hasattr(raw_scores, "tolist") else list(raw_scores)
    )
    if not isinstance(scores_list, list):
        scores_list = [scores_list]

    out_records: list[dict[str, Any]] = []
    for i, score in enumerate(scores_list):
        out_records.append(
            {
                **records[i],
                "score": float(score),
                "model_version": "bge-reranker-v2-m3",
            }
        )

    output_path.write_text(json.dumps(out_records, ensure_ascii=False), encoding="utf-8")
    click.echo(f"wrote {len(out_records)} records → {output_path}", err=True)


@main.command()
@click.option("--query", required=True, help="Query string.")
@click.option(
    "--passages",
    required=True,
    help="JSON array of passage strings on stdin or as --passages='[\"…\", \"…\"]'.",
)
@click.option("--device", default=None, help="torch device override.")
def score(query: str, passages: str, device: str | None) -> None:
    """One-shot score: print a JSON array of {passage, score} sorted desc."""
    try:
        from sentence_transformers import CrossEncoder
    except ImportError as exc:
        raise click.ClickException(
            "sentence-transformers not installed. Install with `pip install -e '.[bge]'`."
        ) from exc

    parsed = json.loads(passages)
    if not isinstance(parsed, list) or not all(isinstance(p, str) for p in parsed):
        raise click.BadParameter("--passages must be a JSON array of strings")
    model = CrossEncoder("BAAI/bge-reranker-v2-m3", device=device)
    import torch

    raw = model.predict(
        [(query, p) for p in parsed],
        activation_fct=torch.nn.Sigmoid(),
        show_progress_bar=False,
    )
    scores = raw.tolist() if hasattr(raw, "tolist") else list(raw)
    if not isinstance(scores, list):
        scores = [scores]
    out = [
        {"passage": p, "score": float(s)} for p, s in zip(parsed, scores)
    ]
    out.sort(key=lambda r: r["score"], reverse=True)
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
