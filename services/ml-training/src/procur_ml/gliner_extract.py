"""GLiNER NER extraction — multilingual, label-flexible NER for
procur. See migration 0088 for schema rationale.

Why GLiNER over off-the-shelf NER:
  * Open-vocabulary: we pass our own label list per call (company,
    person, title, product, fuel_grade, crude_grade, port, terminal,
    vessel, bank, payment_instrument, incoterm, country,
    document_type) — no fine-tuning required to add labels.
  * Multilingual via the multitask checkpoint.
  * Cheap on CPU; ~50-200ms per document.

Workflow:
  1. Some upstream produces `texts.json` — list of records with
     source_type + source_id + text.
  2. python -m procur_ml.gliner_extract extract \\
        --input texts.json --output spans.json
     produces spans.json: list of records with the same source_type +
     source_id plus `spans: [{label, value, start, end, confidence}]`.
  3. A tsx upsert script reads spans.json and writes to
     extracted_entities via upsertExtractedEntities from @procur/catalog.

Behind the optional [gliner] extra:
    pip install -e '.[gliner]'

Discipline: GLiNER extracts. An LLM is only invoked downstream for
ambiguous synthesis the rules-based + NER pass can't handle. This
module never calls an LLM; it just runs the model and writes JSON.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import click

# v1 label inventory matches packages/db/src/schema/extracted-entities.ts
# GLINER_LABELS — keep these in sync.
DEFAULT_LABELS = (
    "company",
    "person",
    "title",
    "product",
    "fuel_grade",
    "crude_grade",
    "port",
    "terminal",
    "vessel",
    "bank",
    "payment_instrument",
    "incoterm",
    "country",
    "document_type",
)


def _load(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise click.BadParameter(f"{path} must contain a JSON array of records")
    return data


def _validate(record: dict[str, Any]) -> None:
    required = ("source_type", "source_id", "text")
    missing = [k for k in required if k not in record]
    if missing:
        raise click.BadParameter(
            f"record missing required fields: {missing} (got {sorted(record.keys())})"
        )
    if not isinstance(record["text"], str) or not record["text"].strip():
        raise click.BadParameter(
            f"record {record.get('source_id')} has empty text — filter these upstream"
        )


@click.group()
def main() -> None:
    """GLiNER NER extraction for procur."""


@main.command()
@click.option(
    "--input",
    "input_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="JSON array of {source_type, source_id, text, labels?} records.",
)
@click.option(
    "--output",
    "output_path",
    type=click.Path(dir_okay=False, path_type=Path),
    required=True,
    help="Where to write extracted spans (JSON array, same shape +`spans`).",
)
@click.option(
    "--model",
    default="urchade/gliner_multi-v2.1",
    show_default=True,
    help="Hugging Face model id. Multilingual multitask checkpoint by default.",
)
@click.option(
    "--threshold",
    type=float,
    default=0.4,
    show_default=True,
    help="Minimum confidence to keep a span. GLiNER scores are softmax-style in [0, 1].",
)
@click.option(
    "--device",
    default=None,
    help="torch device override ('cuda' / 'mps' / 'cpu'). Auto-detects when omitted.",
)
def extract(
    input_path: Path,
    output_path: Path,
    model: str,
    threshold: float,
    device: str | None,
) -> None:
    """Extract NER spans from every record in --input."""
    try:
        from gliner import GLiNER
    except ImportError as exc:
        raise click.ClickException(
            "gliner not installed. Install with `pip install -e '.[gliner]'`."
        ) from exc

    records = _load(input_path)
    for r in records:
        _validate(r)
    if not records:
        click.echo("(no records to process)")
        output_path.write_text("[]", encoding="utf-8")
        return

    click.echo(f"loading {model} (device={device or 'auto'})", err=True)
    gliner_model = GLiNER.from_pretrained(model)
    if device:
        gliner_model = gliner_model.to(device)

    out_records: list[dict[str, Any]] = []
    total = len(records)
    click.echo(f"extracting from {total} records (threshold={threshold})", err=True)

    for i, record in enumerate(records):
        labels = record.get("labels") or list(DEFAULT_LABELS)
        # GLiNER takes (text, labels, threshold) and returns a list
        # of dicts: {start, end, text, label, score}. Map to our
        # span shape (the upsert script normalizes from there).
        try:
            raw_spans = gliner_model.predict_entities(
                record["text"],
                list(labels),
                threshold=threshold,
            )
        except Exception as exc:  # noqa: BLE001
            click.echo(f"  record {record['source_id']} failed: {exc}", err=True)
            raw_spans = []

        spans = [
            {
                "label": s.get("label"),
                "value": s.get("text"),
                "start": int(s["start"]) if "start" in s else None,
                "end": int(s["end"]) if "end" in s else None,
                "confidence": round(float(s.get("score", 0.0)), 4),
            }
            for s in raw_spans
            if s.get("label") and s.get("text")
        ]
        out_records.append(
            {
                "source_type": record["source_type"],
                "source_id": record["source_id"],
                "text": record["text"],
                "spans": spans,
                "model_version": model.split("/")[-1] or "gliner-multitask-v1",
            }
        )
        if (i + 1) % 25 == 0 or (i + 1) == total:
            click.echo(f"  {i + 1} / {total}", err=True)

    output_path.write_text(json.dumps(out_records, ensure_ascii=False), encoding="utf-8")
    click.echo(f"wrote {len(out_records)} records → {output_path}", err=True)


if __name__ == "__main__":
    main()
