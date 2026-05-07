"""BGE-M3 multilingual text embeddings — producer for procur's
`bge_text_embeddings` table.

Why BGE-M3:
  * Open-source (BAAI, MIT licensed)
  * Multilingual — 100+ languages, strong on Spanish / Portuguese /
    Arabic / Chinese in addition to English
  * Long context — up to 8192 tokens, useful for entity_web_summaries
    + LOIs / ICPOs / assays / deal notes that blow past most
    encoder-style limits
  * 1024-dim dense output (the only mode this module produces in v1;
    sparse + multi-vector are deferred until query throughput
    justifies the storage)

Workflow:
  1. Some upstream (a tsx script or a SQL dump) produces `texts.json`
     — a list of records, each with owner_type + owner_id +
     embedding_kind + text + optional language hint.
  2. `python -m procur_ml.bge_m3 embed --input texts.json --output
     embeddings.json` runs the model and writes back enriched records
     including the 1024-dim vector per row.
  3. A tsx upsert script reads `embeddings.json` and writes to the
     DB via `upsertBgeEmbedding` from @procur/catalog.

Decoupling embed (Python, GPU-friendly) from upsert (TS, sees the
Drizzle schema) keeps each step in its native language and avoids
threading psycopg through the ML pipeline.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import click


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_records(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise click.BadParameter(f"{path} must contain a JSON array of records")
    return data


def _validate_record(record: dict[str, Any]) -> None:
    required = ("owner_type", "owner_id", "embedding_kind", "text")
    missing = [k for k in required if k not in record]
    if missing:
        raise click.BadParameter(
            f"record missing required fields: {missing} (got keys {sorted(record.keys())})"
        )
    if not isinstance(record["text"], str) or not record["text"].strip():
        raise click.BadParameter(
            f"record {record.get('owner_id')} has empty `text` — skip these upstream"
        )


@click.group()
def main() -> None:
    """BGE-M3 multilingual text-embedding producer for procur."""


@main.command()
@click.option(
    "--input",
    "input_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="JSON file containing records to embed: [{owner_type, owner_id, embedding_kind, text, language?}, ...]",
)
@click.option(
    "--output",
    "output_path",
    type=click.Path(dir_okay=False, path_type=Path),
    required=True,
    help="Where to write enriched records (with embedding[] + content_hash). Same JSON shape, +`embedding`, +`content_hash`, +`model_version`.",
)
@click.option(
    "--batch-size",
    type=int,
    default=16,
    show_default=True,
    help="Records per BGE-M3 forward pass. 16 is conservative for laptop CPUs; bump to 64+ on GPU.",
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
    help="BGE-M3 max sequence length. Longer than this gets truncated by the tokenizer.",
)
def embed(
    input_path: Path,
    output_path: Path,
    batch_size: int,
    device: str | None,
    max_length: int,
) -> None:
    """Embed every record in --input, write enriched records to --output.

    Computes only the dense head (1024-dim). Sparse + ColBERT-style
    multi-vector heads are deferred until query throughput justifies
    the storage; the dense vector is what the catalog query layer
    expects today.
    """
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise click.ClickException(
            "sentence-transformers not installed. Install with `pip install -e '.[bge]'`."
        ) from exc

    records = _load_records(input_path)
    for record in records:
        _validate_record(record)
    if not records:
        click.echo("(no records to embed)")
        output_path.write_text("[]", encoding="utf-8")
        return

    click.echo(
        f"loading BAAI/bge-m3 (device={device or 'auto'})",
        err=True,
    )
    model = SentenceTransformer("BAAI/bge-m3", device=device)
    # BGE-M3 supports up to 8192 tokens; sentence-transformers defaults
    # to the model's stored max_seq_length (often 512). Override to
    # match our --max-length flag so long documents aren't silently
    # truncated.
    model.max_seq_length = max_length

    texts = [r["text"] for r in records]
    out_records: list[dict[str, Any]] = []
    total = len(texts)
    click.echo(f"embedding {total} records (batch_size={batch_size})", err=True)

    for batch_start in range(0, total, batch_size):
        batch = texts[batch_start : batch_start + batch_size]
        # encode returns a numpy array of shape (n, 1024). Normalize=True
        # gives unit vectors so downstream cosine == dot-product (and
        # plays well with pgvector's cosine_ops index).
        dense = model.encode(
            batch,
            batch_size=batch_size,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        for i, vec in enumerate(dense):
            record = records[batch_start + i]
            embedding = vec.tolist() if hasattr(vec, "tolist") else list(vec)
            out_records.append(
                {
                    **record,
                    "embedding": embedding,
                    "content_hash": _sha256_hex(record["text"]),
                    "model_version": "bge-m3",
                }
            )
        click.echo(
            f"  {min(batch_start + batch_size, total)} / {total}",
            err=True,
        )

    output_path.write_text(
        json.dumps(out_records, ensure_ascii=False), encoding="utf-8"
    )
    click.echo(f"wrote {len(out_records)} records → {output_path}", err=True)


@main.command()
@click.option(
    "--text",
    "text",
    required=True,
    help="Text to embed against the same model the corpus was indexed with.",
)
@click.option(
    "--device",
    default=None,
    help="torch device override.",
)
def query(text: str, device: str | None) -> None:
    """Embed a single query string and print the 1024-dim vector as
    JSON to stdout. Used by the catalog `findByBgeText` flow when
    a TS-side query needs an embedding without a separate API server.
    """
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise click.ClickException(
            "sentence-transformers not installed. Install with `pip install -e '.[bge]'`."
        ) from exc

    model = SentenceTransformer("BAAI/bge-m3", device=device)
    vec = model.encode(
        [text],
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )[0]
    embedding = vec.tolist() if hasattr(vec, "tolist") else list(vec)
    json.dump(embedding, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
