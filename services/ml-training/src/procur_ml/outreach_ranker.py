"""LightGBM reply-within-14-days classifier — third leg of procur's
ML stack (after BGE-reranker and GLiNER).

Why LightGBM over XGBoost (per Cole's brief):
  * Native categorical support — country / product / signal_kind /
    org_industry land as strings; no one-hot encoding needed.
  * Better with low label counts. Leaf-wise growth produces sharper
    splits with limited data than XGBoost's level-wise growth.
  * Lighter footprint (~3MB wheel vs ~40MB).

Workflow:
  1. `pnpm --filter @procur/db extract-outreach-training-data
        --output train.json` dumps labeled snapshots from
     outreach_feature_snapshots.
  2. `python -m procur_ml.outreach_ranker train --input train.json
        --output model.lgb` trains + saves.
  3. `python -m procur_ml.outreach_ranker predict --model model.lgb
        --features features.json` scores. Returns probability of
     replied_within_14d in [0, 1].

Discipline:
  * ML ranks; it does NOT send. Approval gate stays mandatory.
  * Predictions are INTERNAL — never surface in operator-facing
    copy. Use them to reorder a backlog of pending approvals or
    trigger a "low-likelihood, double-check?" prompt.
  * Heuristics are the fallback path until label volume is
    sufficient (~500 labels for a binary classifier).

Behind the optional [outreach_rank] extra:
    pip install -e '.[outreach_rank]'
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import click


# Numeric features the trainer treats as continuous. Anything not in
# this list is treated as categorical (LightGBM's native handling).
NUMERIC_FEATURES = {
    "body_length",
    "web_fact_count",
    "max_fuel_signal_bbl_yr",
    "fuel_signal_confidence_sum",
    "touchpoints_all_time",
    "touchpoints_last_30d",
    "hours_since_last_touch",
    "ml_evidence_count",
    "ml_total_score",
    "risk_warning_count",
}

# Boolean features cast to 0/1 (LightGBM treats them as numeric).
BOOLEAN_FEATURES = {
    "has_template",
    "apollo_cached",
    "contact_has_phone",
    "contact_has_email",
}


def _load(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise click.BadParameter(f"{path} must contain a JSON array of records")
    return data


def _build_dataframe(rows: list[dict[str, Any]]):
    """Flatten rows into a pandas DataFrame the trainer understands.

    Each row from the extract script has shape:
      { approval_id, features: {...}, replied_within_14d: bool }
    Output columns:
      <feature names> + label (when training).
    """
    try:
        import pandas as pd  # noqa: PLC0415
    except ImportError as exc:
        raise click.ClickException(
            "pandas not installed. Install with `pip install -e '.[outreach_rank]'`."
        ) from exc

    frames = []
    for row in rows:
        feats = row.get("features", {}) or {}
        flat: dict[str, Any] = {}
        for k, v in feats.items():
            if k in BOOLEAN_FEATURES:
                flat[k] = 1 if bool(v) else 0
            elif k in NUMERIC_FEATURES:
                flat[k] = float(v) if v is not None else 0.0
            else:
                # Categorical — LightGBM accepts strings via the
                # `categorical_feature` param (set below).
                flat[k] = str(v) if v is not None else "__null__"
        if "replied_within_14d" in row:
            flat["__label__"] = (
                1
                if row["replied_within_14d"] is True
                else 0
                if row["replied_within_14d"] is False
                else None
            )
        frames.append(flat)
    df = pd.DataFrame(frames)
    return df


def _categorical_columns(df) -> list[str]:
    """Columns that LightGBM should treat as categorical."""
    return [
        c
        for c in df.columns
        if c != "__label__" and c not in NUMERIC_FEATURES and c not in BOOLEAN_FEATURES
    ]


@click.group()
def main() -> None:
    """LightGBM outreach reply-within-14-days classifier."""


@main.command()
@click.option(
    "--input",
    "input_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="JSON: list of {approval_id, features, replied_within_14d}.",
)
@click.option(
    "--output",
    "output_path",
    type=click.Path(dir_okay=False, path_type=Path),
    required=True,
    help="Where to save the trained LightGBM model (text format).",
)
@click.option(
    "--num-leaves",
    type=int,
    default=31,
    show_default=True,
)
@click.option(
    "--learning-rate",
    type=float,
    default=0.05,
    show_default=True,
)
@click.option(
    "--num-iterations",
    type=int,
    default=200,
    show_default=True,
)
@click.option(
    "--min-data",
    type=int,
    default=5,
    show_default=True,
    help="min_data_in_leaf — keep low while label count is small.",
)
@click.option(
    "--seed",
    type=int,
    default=42,
    show_default=True,
)
def train(
    input_path: Path,
    output_path: Path,
    num_leaves: int,
    learning_rate: float,
    num_iterations: int,
    min_data: int,
    seed: int,
) -> None:
    """Train the reply-within-14d classifier on labeled snapshots."""
    try:
        import lightgbm as lgb  # noqa: PLC0415
        from sklearn.metrics import roc_auc_score  # noqa: PLC0415
        from sklearn.model_selection import train_test_split  # noqa: PLC0415
    except ImportError as exc:
        raise click.ClickException(
            "lightgbm/scikit-learn not installed. Install with `pip install -e '.[outreach_rank]'`."
        ) from exc

    rows = _load(input_path)
    if not rows:
        raise click.ClickException("input is empty — extract more labels first")

    df = _build_dataframe(rows)
    df = df[df["__label__"].notnull()].reset_index(drop=True)
    if len(df) < 10:
        raise click.ClickException(
            f"only {len(df)} labeled rows — need ≥10 to train. Run the heuristic fallback for now."
        )

    pos = int(df["__label__"].sum())
    neg = len(df) - pos
    click.echo(f"loaded {len(df)} labeled rows ({pos} positive / {neg} negative)", err=True)

    cats = _categorical_columns(df)
    for c in cats:
        df[c] = df[c].astype("category")

    X = df.drop(columns=["__label__"])
    y = df["__label__"].astype(int)

    if len(df) >= 50:
        X_train, X_val, y_train, y_val = train_test_split(
            X, y, test_size=0.2, random_state=seed, stratify=y
        )
    else:
        X_train, y_train = X, y
        X_val, y_val = X, y  # not enough data for a holdout

    train_set = lgb.Dataset(
        X_train, label=y_train, categorical_feature=cats
    )
    val_set = lgb.Dataset(
        X_val, label=y_val, categorical_feature=cats, reference=train_set
    )

    params = {
        "objective": "binary",
        "metric": "binary_logloss",
        "num_leaves": num_leaves,
        "learning_rate": learning_rate,
        "min_data_in_leaf": min_data,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.9,
        "bagging_freq": 5,
        "verbosity": -1,
        "seed": seed,
    }

    booster = lgb.train(
        params,
        train_set,
        num_boost_round=num_iterations,
        valid_sets=[val_set],
        callbacks=[lgb.early_stopping(stopping_rounds=20), lgb.log_evaluation(0)],
    )

    val_preds = booster.predict(X_val, num_iteration=booster.best_iteration)
    auc = roc_auc_score(y_val, val_preds) if len(set(y_val)) > 1 else float("nan")
    click.echo(
        f"trained {booster.best_iteration} iters · holdout AUC: {auc:.3f}",
        err=True,
    )

    booster.save_model(str(output_path), num_iteration=booster.best_iteration)
    click.echo(f"saved → {output_path}", err=True)


@main.command()
@click.option(
    "--model",
    "model_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--features",
    "features_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="JSON: list of {approval_id, features} records to score.",
)
def predict(model_path: Path, features_path: Path) -> None:
    """Score a JSON of feature vectors. Prints
    [{approval_id, prob_reply_14d}, ...] to stdout.
    """
    try:
        import lightgbm as lgb  # noqa: PLC0415
    except ImportError as exc:
        raise click.ClickException(
            "lightgbm not installed. Install with `pip install -e '.[outreach_rank]'`."
        ) from exc

    rows = _load(features_path)
    if not rows:
        json.dump([], sys.stdout)
        sys.stdout.write("\n")
        return

    df = _build_dataframe(rows)
    if "__label__" in df.columns:
        df = df.drop(columns=["__label__"])
    cats = _categorical_columns(df)
    for c in cats:
        df[c] = df[c].astype("category")

    booster = lgb.Booster(model_file=str(model_path))
    preds = booster.predict(df)

    out = [
        {"approval_id": rows[i].get("approval_id"), "prob_reply_14d": float(p)}
        for i, p in enumerate(preds)
    ]
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
