"""Embedding writer — upsert from embeddings.json into procur Postgres.

Reads the JSON produced by train.py and writes per-entity rows into
the entity_embeddings table (schema shipped in Component A — PR #419).

Currently only entity nodes are written. signal_embeddings target a
different table; vessels / ports / crude_grades aren't first-class
embedding consumers in chat tools yet, so we skip them here. Easy to
extend when consumers need them.

Run:
    python -m procur_ml.upsert --embeddings embeddings.json
    python -m procur_ml.upsert --embeddings embeddings.json --kind combined_v1
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import click
import psycopg
from dotenv import load_dotenv

logger = logging.getLogger("procur_ml.upsert")


def _vector_literal(values: list[float]) -> str:
    """pgvector accepts text-format '[1,2,3]'. Keeps the SQL clean
    and avoids parameterized binding gymnastics for the vector type."""
    return "[" + ",".join(f"{v:.8f}" for v in values) + "]"


def upsert_entity_embeddings(
    conn: psycopg.Connection,
    embeddings_payload: dict,
    *,
    embedding_kind: str,
) -> int:
    """Write all entity embeddings to entity_embeddings.

    Returns the count of rows upserted. Idempotent —
    ON CONFLICT DO UPDATE on (entity_slug, embedding_kind, model_version).
    """
    metadata = embeddings_payload["metadata"]
    embeddings = embeddings_payload["embeddings"].get("entity", [])
    if not embeddings:
        logger.warning("no entity embeddings in payload — nothing to upsert")
        return 0

    expected_dim = int(metadata["embeddingDim"])
    model_version = str(metadata["modelVersion"])
    trained_at = metadata["trainedAt"]

    inserted = 0
    with conn.cursor() as cur:
        for row in embeddings:
            slug = row["id"]
            vector = row["vector"]
            if len(vector) != expected_dim:
                logger.warning(
                    "dim mismatch for %s: expected %d, got %d — skipping",
                    slug,
                    expected_dim,
                    len(vector),
                )
                continue
            cur.execute(
                """
                INSERT INTO entity_embeddings (
                    entity_slug, embedding_kind, embedding, embedding_dim,
                    model_version, trained_at
                ) VALUES (
                    %s, %s, %s::vector, %s, %s, %s::timestamp
                )
                ON CONFLICT (entity_slug, embedding_kind, model_version)
                DO UPDATE SET
                    embedding = EXCLUDED.embedding,
                    trained_at = EXCLUDED.trained_at;
                """,
                (slug, embedding_kind, _vector_literal(vector), expected_dim, model_version, trained_at),
            )
            inserted += 1
    conn.commit()
    return inserted


@click.command()
@click.option(
    "--embeddings",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--kind",
    type=str,
    default="graph_v1",
    help="entity_embeddings.embedding_kind value (default 'graph_v1' per Component A schema).",
)
@click.option(
    "--database-url",
    type=str,
    default=None,
    envvar="DATABASE_URL",
    help="Postgres connection string. Falls back to DATABASE_URL env var; load .env.local first.",
)
def main(embeddings: Path, kind: str, database_url: str | None) -> None:
    """Upsert trained embeddings from a JSON file into procur Postgres."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    # Load .env.local from repo root if present — keeps the script
    # consistent with the procur Node-side scripts which all do this.
    load_dotenv(dotenv_path=Path("../../.env.local"))
    load_dotenv(dotenv_path=Path("../../.env"))
    if database_url is None:
        database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise click.ClickException("DATABASE_URL not set — populate .env.local or pass --database-url")

    payload = json.loads(embeddings.read_text())
    logger.info(
        "model_version=%s embeddingDim=%s entities=%d",
        payload["metadata"].get("modelVersion"),
        payload["metadata"].get("embeddingDim"),
        len(payload["embeddings"].get("entity", [])),
    )

    with psycopg.connect(database_url) as conn:
        n = upsert_entity_embeddings(conn, payload, embedding_kind=kind)
    logger.info("upserted %d rows into entity_embeddings (kind=%s)", n, kind)


if __name__ == "__main__":
    main()
