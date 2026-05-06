"""JSON graph extract → torch_geometric HeteroData.

Loads the JSON file produced by `pnpm --filter @procur/db extract-graph`
(see packages/db/src/extract-graph.ts) and converts it to a PyG
HeteroData object ready for GraphSAGE.

Edge type mapping — JSON uses dash-separated names; PyG uses tuples.
Names align with the brief's §5.2 taxonomy:

    entity-owns-entity      → ('entity', 'owns', 'entity')
    entity-located-port     → ('entity', 'located_at', 'port')
    vessel-called-port      → ('vessel', 'called', 'port')
    vessel-carried-grade    → ('vessel', 'carried', 'crude_grade')
    port-handles-grade      → ('port', 'handles', 'crude_grade')
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
from torch_geometric.data import HeteroData
from torch_geometric.transforms import ToUndirected

# Maps JSON edge type strings to PyG canonical (src, rel, dst) tuples.
# Order is irrelevant — PyG indexes by tuple.
EDGE_TYPE_MAP: dict[str, tuple[str, str, str]] = {
    "entity-owns-entity": ("entity", "owns", "entity"),
    "entity-located-port": ("entity", "located_at", "port"),
    "vessel-called-port": ("vessel", "called", "port"),
    "vessel-carried-grade": ("vessel", "carried", "crude_grade"),
    "port-handles-grade": ("port", "handles", "crude_grade"),
}


@dataclass
class ProcurGraph:
    """Loaded graph + ID maps for round-tripping back to procur slugs."""

    data: HeteroData
    """PyG HeteroData with x, edge_index, edge_weight per type."""

    node_ids: dict[str, list[str]]
    """node_type → ordered list of slug/mmsi (index N corresponds to row N in data[node_type].x)."""

    feature_names: dict[str, list[str]]
    """node_type → list of feature names matching the column order of x."""

    metadata: dict[str, Any]
    """Original metadata block from the JSON for provenance."""


def load_graph(path: Path | str, *, undirected: bool = True) -> ProcurGraph:
    """Load a procur graph JSON into a PyG HeteroData object.

    Args:
        path: Path to the JSON file produced by extract-graph.
        undirected: If True, applies PyG's ToUndirected transform to add
            reverse edge types. GraphSAGE message passing benefits from
            bidirectional edges. Default True.

    Returns:
        ProcurGraph with the HeteroData + the ID/feature-name maps so
        downstream upsert can round-trip embeddings back to slugs.
    """
    raw = json.loads(Path(path).read_text())

    data = HeteroData()
    node_ids: dict[str, list[str]] = {}

    for node_type, payload in raw["nodes"].items():
        ids: list[str] = list(payload["ids"])
        features: list[list[float]] = payload["features"]
        if len(ids) == 0:
            # Empty node type — still register so PyG knows about it,
            # but use a 1×D zero matrix to keep downstream conv layers
            # happy. Edge types pointing to this node type will be empty.
            dim = len(features[0]) if features else 1
            data[node_type].x = torch.zeros((0, dim), dtype=torch.float32)
            data[node_type].num_nodes = 0
        else:
            data[node_type].x = torch.tensor(features, dtype=torch.float32)
            data[node_type].num_nodes = len(ids)
        node_ids[node_type] = ids

    # Pre-build src→idx maps per node type for efficient edge construction.
    id_to_idx: dict[str, dict[str, int]] = {
        nt: {nid: i for i, nid in enumerate(ids)} for nt, ids in node_ids.items()
    }

    for edge_name, edges in raw["edges"].items():
        triple = EDGE_TYPE_MAP.get(edge_name)
        if triple is None:
            # Unknown edge type — skip gracefully. extract-graph may
            # ship a new edge before this loader is updated.
            continue
        src_type, _, dst_type = triple
        if not edges:
            data[triple].edge_index = torch.zeros((2, 0), dtype=torch.long)
            data[triple].edge_weight = torch.zeros((0,), dtype=torch.float32)
            continue
        # The JSON already encodes src/dst as integer indices into the
        # respective node arrays — extract-graph emits indices, not slugs.
        # If a future ingest emits slugs instead, fall back to id_to_idx.
        src_idx: list[int] = []
        dst_idx: list[int] = []
        weights: list[float] = []
        for edge in edges:
            src = edge["src"]
            dst = edge["dst"]
            if isinstance(src, str):
                src = id_to_idx[src_type].get(src)
                if src is None:
                    continue
            if isinstance(dst, str):
                dst = id_to_idx[dst_type].get(dst)
                if dst is None:
                    continue
            src_idx.append(int(src))
            dst_idx.append(int(dst))
            weights.append(float(edge.get("weight", 1.0)))
        if not src_idx:
            data[triple].edge_index = torch.zeros((2, 0), dtype=torch.long)
            data[triple].edge_weight = torch.zeros((0,), dtype=torch.float32)
            continue
        data[triple].edge_index = torch.tensor([src_idx, dst_idx], dtype=torch.long)
        data[triple].edge_weight = torch.tensor(weights, dtype=torch.float32)

    if undirected:
        # Adds reverse edges for every edge type, prefixed with 'rev_'.
        # Critical for GraphSAGE — without it, message passing only
        # flows in the direction the edge was extracted.
        data = ToUndirected()(data)

    return ProcurGraph(
        data=data,
        node_ids=node_ids,
        feature_names=raw["metadata"]["featureNames"],
        metadata=raw["metadata"],
    )


def feature_dims(graph: ProcurGraph) -> dict[str, int]:
    """Per-node-type input feature dimensions. Sourced from the
    metadata block so the model layer config matches whatever
    extract-graph emitted."""
    return {nt: int(d) for nt, d in graph.metadata["featureDims"].items()}
