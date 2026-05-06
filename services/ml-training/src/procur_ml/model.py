"""Heterogeneous GraphSAGE model.

Per the brief §5.1 + §5.4 — 2-layer GraphSAGE with heterogeneous
extension via PyG's HeteroConv. Each (src_type, rel, dst_type)
gets its own SAGEConv aggregator so message passing respects the
relation type.

Output: 128-dim embedding per node type. Brief §10 lists embedding
dimension as deferred-to-implementation; 128 is the recommended
starting point.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import nn
from torch_geometric.nn import HeteroConv, SAGEConv


class HeterogeneousGraphSAGE(nn.Module):
    """2-layer heterogeneous GraphSAGE.

    Each node type has its own input projection (different feature
    dimensions per type — entity is 50d, vessel 32d, etc., per the
    extract-graph emission). After projection all types share the
    same hidden dim, so HeteroConv with SAGEConv works on the
    common space.
    """

    def __init__(
        self,
        feature_dims: dict[str, int],
        hidden_dim: int = 128,
        out_dim: int = 128,
        edge_types: list[tuple[str, str, str]] | None = None,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.node_types = list(feature_dims.keys())
        self.hidden_dim = hidden_dim
        self.out_dim = out_dim
        self.dropout = dropout

        # Per-node-type input projection so heterogeneous feature
        # dims map into a shared hidden space before message passing.
        self.input_proj = nn.ModuleDict(
            {nt: nn.Linear(d, hidden_dim) for nt, d in feature_dims.items()}
        )

        if edge_types is None:
            raise ValueError("edge_types must be provided so HeteroConv knows the relations")

        # HeteroConv layer 1 — one SAGEConv per edge type.
        self.conv1 = HeteroConv(
            {et: SAGEConv((-1, -1), hidden_dim) for et in edge_types},
            aggr="mean",
        )
        # HeteroConv layer 2 — produces the final embedding dim.
        self.conv2 = HeteroConv(
            {et: SAGEConv((-1, -1), out_dim) for et in edge_types},
            aggr="mean",
        )

    def forward(
        self,
        x_dict: dict[str, torch.Tensor],
        edge_index_dict: dict[tuple[str, str, str], torch.Tensor],
    ) -> dict[str, torch.Tensor]:
        # Project per-type inputs to shared hidden dim.
        h_dict = {nt: F.relu(self.input_proj[nt](x)) for nt, x in x_dict.items()}
        h_dict = {
            nt: F.dropout(h, p=self.dropout, training=self.training)
            for nt, h in h_dict.items()
        }

        # Message-pass layer 1
        h_dict = self.conv1(h_dict, edge_index_dict)
        h_dict = {nt: F.relu(h) for nt, h in h_dict.items()}
        h_dict = {
            nt: F.dropout(h, p=self.dropout, training=self.training)
            for nt, h in h_dict.items()
        }

        # Message-pass layer 2 (output)
        h_dict = self.conv2(h_dict, edge_index_dict)
        return h_dict


def link_score(src_emb: torch.Tensor, dst_emb: torch.Tensor) -> torch.Tensor:
    """Dot-product link score — production standard for two-tower
    retrieval and link prediction objectives."""
    return (src_emb * dst_emb).sum(dim=-1)
