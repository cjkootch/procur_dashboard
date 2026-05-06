# Procur ML Layer: Graph Embeddings, Entity Matching, and Ranking

**Status:** working brief, future implementation
**Owner:** Cole (procur is Cole's personal IP)
**Last updated:** 2026-05-05
**Repo:** `cjkootch/procur_dashboard`
**Implementation context:** This brief is consumed by Claude Code at the time of implementation. It specifies the ML/recommendation layer to be added to procur once the data graph foundation is mature enough to support learning-based components. Implementation timing is gated on commercial validation of existing procur infrastructure, not on this brief's completion.

---

## 1. What this brief is and isn't

This brief specifies the addition of an ML layer to procur covering graph embeddings, entity similarity search, link prediction, two-tower retrieval, and learned ranking for the match-queue and signal-surfacing systems. The goal is to extend procur from "explicit signals over observed data" to "explicit signals plus learned latent structure across the heterogeneous graph."

**It is not** a research proposal. The architecture choices below are opinionated and reflect production patterns from comparable systems (Pinterest PinSage, Twitter SimClusters/TwHIN, Airbnb listing embeddings, LinkedIn member-job matching, YouTube two-tower). The brief specifies what to implement, not what to investigate.

**It is not** a Twitter algorithm port. While SimClusters and TwHIN influence the design, the implementation should not assume Twitter's specific engagement signals or follow graph. Procur's data model and use cases are different and require bespoke architecture.

**It is not** an LLM-augmented system in the chat-with-procur sense (that exists separately in procur and vex chat tools). This is the embedding + retrieval + ranking layer that runs underneath user-facing tools and improves their answers without being directly invoked by users.

---

## 2. Strategic context

The current state of procur is mature on explicit data layers: entity rolodex, signal ingestion, match queue, ownership graph, slate-fit, customs context, cargo trips, KYC infrastructure, document upload, news feed, commodity prices, vessels, ports, and crude grades + assays. Each of these layers stores observed facts about counterparties, cargoes, signals, and relationships.

What procur does not yet do is learn latent structure from those observed facts. Specifically:

- When a new entity enters the data, procur cannot immediately surface "this entity is structurally similar to these other entities you've qualified" without explicit attribute matching
- When a counterparty has partial information (no segment classification, no scale estimate, no historical transactions), procur cannot infer those missing attributes from the entity's position in the broader graph
- When the match-queue ranks signals to surface, ranking uses heuristics over engagement velocity and signal recency rather than learned ranking from match-outcome feedback (PR #309 added the feedback loop; the learning component to consume that feedback is not yet built)
- When a signal arrives that mentions an entity not yet in known_entities, procur has no graph-based mechanism for resolving the mention to existing entities or proposing new ones with high-confidence attribute predictions

The ML layer specified in this brief addresses each of these gaps. The output is a system where procur's commercial value compounds with data accumulation rather than being capped by the labor of explicit attribute curation.

---

## 3. Architecture overview

The ML layer consists of four production components, in implementation priority order:

**Component A — Vector store and approximate nearest neighbor (ANN) search.** Foundation infrastructure that stores embeddings for every entity, signal, document, and other relevant object. Enables sub-second similarity search at scale. Required for every other component.

**Component B — Graph embedding training pipeline.** Trains embeddings for entities and other graph nodes using GraphSAGE-family algorithms over procur's heterogeneous graph. Produces the embeddings stored in Component A.

**Component C — Two-tower retrieval for match-queue and signal surfacing.** Replaces heuristic ranking in match-queue with learned ranking from match-outcome feedback. Two-tower architecture maps signal context (one tower) to candidate entities (other tower) with learned similarity for retrieval.

**Component D — Entity resolution and attribute prediction.** Uses graph embeddings to resolve entity mentions in incoming signals to existing known_entities, and to predict missing attributes (segment, scale, geography) for partial-information entities.

These components share infrastructure (vector store, training pipeline orchestration) but are independently deployable. Implementation should proceed in order: A blocks all others, B produces what A stores, C and D consume B's output independently.

---

## 4. Component A — Vector store and ANN search

### 4.1 Technology choice

**Recommended: FAISS (Facebook AI Similarity Search) with PostgreSQL pgvector for persistence.**

Rationale:
- FAISS is the production standard for ANN search at procur's likely scale (10K-1M vectors). Battle-tested at billions of vectors elsewhere.
- pgvector keeps embeddings in the same database as the rest of procur's data, eliminating sync complexity.
- pgvector with HNSW index supports sub-100ms similarity search up to ~1M vectors without external service dependencies.
- Postgres-native integration means ML embeddings join naturally with existing tables (known_entities, signals, etc.) without ETL.

**Alternative considered:** Pinecone, Weaviate, Qdrant. All are reasonable but introduce a separate service dependency. Reject unless procur scale exceeds pgvector's comfortable range (>5M vectors or >1000 QPS sustained).

### 4.2 Schema

Working schema for the embedding store:

```sql
-- Enable pgvector extension first
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE entity_embeddings (
    id BIGSERIAL PRIMARY KEY,
    entity_slug TEXT NOT NULL REFERENCES known_entities(slug),
    embedding_kind TEXT NOT NULL,  -- 'graph_v1', 'attribute_v1', 'combined_v1'
    embedding vector(128) NOT NULL,
    embedding_dim INTEGER NOT NULL,
    model_version TEXT NOT NULL,    -- 'graphsage_2026_05_v1'
    trained_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(entity_slug, embedding_kind, model_version)
);

CREATE INDEX idx_entity_emb_slug ON entity_embeddings(entity_slug);
CREATE INDEX idx_entity_emb_kind ON entity_embeddings(embedding_kind);
CREATE INDEX idx_entity_emb_hnsw ON entity_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE signal_embeddings (
    id BIGSERIAL PRIMARY KEY,
    signal_id BIGINT NOT NULL,  -- references the signal source table; signals come from multiple sources
    signal_source TEXT NOT NULL,
    embedding_kind TEXT NOT NULL,  -- 'text_v1', 'graph_v1'
    embedding vector(128) NOT NULL,
    model_version TEXT NOT NULL,
    trained_at TIMESTAMPTZ NOT NULL,
    UNIQUE(signal_id, signal_source, embedding_kind, model_version)
);

CREATE INDEX idx_signal_emb_signal ON signal_embeddings(signal_id, signal_source);
CREATE INDEX idx_signal_emb_hnsw ON signal_embeddings USING hnsw (embedding vector_cosine_ops);
```

Key design choices:
- **Multiple embedding_kind per entity.** Graph-derived embeddings (from Component B), attribute-derived embeddings (from text/structured features), and combined embeddings (the production retrieval embedding). Storing separately enables debugging and A/B testing.
- **model_version tracked per row.** Embeddings retrain periodically; old embeddings may persist briefly during deployment. Version tracking prevents stale embeddings from polluting search results.
- **HNSW index on the vector column.** Standard ANN index for cosine similarity. Postgres pgvector extension supports this directly.
- **128-dimensional embeddings as default.** Matches typical production sizes for graph embeddings (PinSage uses 128, TwHIN uses 200, GraphSAGE flexible). 128 is a reasonable starting point; tunable per model.

### 4.3 API surface

Expose embedding operations through the existing procur server tier:

```typescript
// Find entities similar to a given entity
async function findSimilarEntities(
  entitySlug: string,
  options: {
    embeddingKind?: string;  // default 'combined_v1'
    limit?: number;          // default 10
    minSimilarity?: number;  // cosine similarity floor
    excludeKinds?: string[]; // exclude entity types
  }
): Promise<{slug: string; similarity: number; entity: KnownEntity}[]>

// Find entities matching a free-text query
async function findEntitiesByText(
  queryText: string,
  options: { limit?: number; embeddingKind?: string }
): Promise<{slug: string; similarity: number; entity: KnownEntity}[]>

// Find signals semantically similar to a given signal
async function findSimilarSignals(
  signalId: number,
  signalSource: string,
  options: { limit?: number }
): Promise<{signalId: number; similarity: number}[]>
```

These should be exposed both as direct procur API endpoints and as MCP tools (procur already has MCP server infrastructure shipped in PRs #401-405).

### 4.4 Implementation effort

3-5 days for a working Component A:
- Day 1: pgvector setup, schema migration, basic insertion/query patterns
- Day 2-3: API surface (Typescript wrappers around pgvector queries), MCP tool exposure
- Day 4: Integration testing with placeholder embeddings (random 128-dim vectors)
- Day 5: Documentation, query patterns, performance profiling

Component A ships independent of B/C/D. The placeholder embeddings get replaced when Component B produces real ones, but Component A's API surface remains stable.

---

## 5. Component B — Graph embedding training pipeline

### 5.1 Algorithm choice

**Recommended: GraphSAGE (Hamilton et al. 2017) with heterogeneous extensions inspired by TwHIN.**

Rationale:
- GraphSAGE is the production-validated graph neural network architecture. Used by Pinterest (PinSage), Uber (Uber Eats), Alibaba, and others for production recommendation.
- Inductive: handles new entities arriving in the graph without retraining (critical for procur, where new entities continuously enter via news feed and customs ingestion).
- Heterogeneous extension via separate node-type-specific aggregators handles procur's data model (entities, vessels, ports, cargoes, signals) without forcing them into a single schema.
- Open-source implementations available in PyTorch Geometric (PyG) and DGL.

**Alternative considered:** Node2Vec (transductive, doesn't generalize to new nodes — reject for procur's continuously growing graph). PinSage specifically (excellent but Pinterest-specific tuning; GraphSAGE is the more flexible foundation). Graph Attention Networks (GAT) (theoretically more powerful but harder to debug; stick with GraphSAGE for v1).

**Alternative considered for heterogeneous handling:** TwHIN's specific architecture — heterogeneous node and edge embeddings with translation between node types. Sophisticated and powerful but more complex to implement and debug than heterogeneous GraphSAGE. Reserve TwHIN-style approach for v2 once GraphSAGE baseline is in production.

### 5.2 Graph definition

The training graph aggregates procur's heterogeneous data:

**Node types:**
- `entity` — from `known_entities` table
- `vessel` — from `vessels` table
- `port` — from `ports` table
- `cargo_trip` — from `cargo_trips` table
- `crude_grade` — from `crude_grades` table
- `signal` — from various signal source tables (news, prices, customs)

**Edge types:**
- `entity-owns-entity` — from ownership graph (PR #347)
- `entity-operates-vessel` — vessel ownership/operation
- `vessel-called-port` — derived from AIS/cargo_trips
- `entity-located-port` — physical asset location
- `entity-trades-crude_grade` — slate-fit relationships (PR #346)
- `entity-mentioned-signal` — signal extraction
- `entity-engaged-cargo_trip` — cargo trip participation
- `entity-counterparty-entity` — derived from observed transactions
- `port-handles-crude_grade` — port-grade relationships

Each edge carries:
- Edge type (categorical)
- Edge weight (numerical, typically 0-1, default 1.0)
- Timestamp of last observation (for temporal decay)
- Confidence score (0-1, especially for derived edges)

### 5.3 Feature engineering

Each node gets initial features for the GraphSAGE message-passing layers:

**Entity features** (8-16 dimensions before learned encoding):
- Segment one-hot (mining / marine / aviation / utility / refinery / industrial / etc.)
- Geographic region embedding (country one-hot)
- Operational scale bucket (small / medium / large / very_large)
- KYC status (cleared / pending / blocked)
- Years in known_entities (continuous, log-scaled)
- Active relationship count (continuous, log-scaled)

**Vessel features:**
- Vessel type (tanker / bulker / container / etc.)
- DWT bucket
- Flag state
- Build year (continuous, log-scaled)

**Port features:**
- Region
- Throughput tier
- Crude handling capability flag
- Bunker availability flag

**Crude grade features:**
- API gravity (continuous)
- Sulfur content (continuous)
- Source region

**Cargo trip features:**
- Trip duration
- Origin-destination region pair
- Cargo volume bucket

**Signal features:**
- Source type
- Sentiment polarity (if NLP-derived)
- Recency (continuous, log-scaled)
- Mention count

These are the inputs to the first GraphSAGE layer. After 2-3 message-passing layers, each node gets a 128-dim embedding that incorporates structural information from its neighbors.

### 5.4 Training procedure

**Training objective: link prediction with negative sampling.**

The model learns embeddings that maximize similarity for nodes connected by observed edges and minimize similarity for randomly sampled non-connected pairs. This is the standard production training objective for graph embedding systems.

Training loop:
1. Sample a batch of edges from the graph
2. For each edge, sample 5-10 negative non-edges (random node pairs not connected)
3. Compute embeddings for all nodes in the batch via 2-layer GraphSAGE message passing
4. Compute loss: maximize similarity for true edges, minimize for negative samples (margin-based or BPR loss)
5. Backpropagate and update model parameters
6. Repeat until convergence (typically 50-200 epochs)

**Training cadence: weekly retraining initially, monthly once stable.**

The graph grows continuously as procur ingests new signals, customs records, news, etc. Embeddings drift if not retrained. Weekly retraining during initial deployment catches model degradation early; once embedding quality is validated as stable, monthly retraining is sufficient.

**Inductive inference for new nodes:**

GraphSAGE's key property is that new nodes can be embedded without retraining the model. When a new entity enters known_entities:
1. Build the node's initial features as above
2. Identify its 1-2 hop neighborhood in the existing graph
3. Run the trained GraphSAGE model forward on this subgraph
4. Output the new entity's embedding
5. Store in entity_embeddings table

This means new entities get high-quality embeddings within minutes of entering procur, without waiting for the next retraining cycle.

### 5.5 Implementation infrastructure

**Recommended stack:**
- **PyTorch Geometric (PyG)** for the GraphSAGE implementation. Better-maintained than DGL, larger community, more recent paper implementations.
- **PyTorch Lightning** for training loop boilerplate. Reduces engineering burden vs. raw PyTorch.
- **MLflow** for experiment tracking and model versioning. Open-source, no service dependency.
- **Trigger.dev v3** for scheduled retraining jobs. Already in procur's stack.

Training infrastructure:
- Initial training runs on a single GPU machine (RTX 4090 or equivalent, ~24GB VRAM sufficient for procur's likely scale through 1M nodes)
- Cloud option: rent a single A100 instance for training runs only; embeddings stored in Postgres so no GPU dependency at inference time
- For procur scale (estimated 10K-100K entities at v1, growing to 1M+ over years), training runs complete in 2-8 hours depending on graph size

### 5.6 Implementation effort

10-15 days for working Component B:
- Days 1-3: Graph extraction pipeline (procur Postgres -> PyG-compatible format), feature engineering for each node type
- Days 4-7: GraphSAGE model implementation, training loop, loss function, evaluation metrics (link prediction AUC, retrieval mAP)
- Days 8-10: Trigger.dev integration for scheduled retraining, MLflow integration for experiment tracking
- Days 11-13: Inductive inference for new entities, integration with Component A storage
- Days 14-15: Validation against held-out edges, qualitative similarity sanity-checking, documentation

---

## 6. Component C — Two-tower retrieval for match-queue

### 6.1 Use case

The match-queue currently surfaces signals to users using heuristic ranking based on engagement velocity, recency, and explicit signal type. The match-outcome feedback loop (PR #309) captures user actions on surfaced matches: clicked / converted / dismissed / ignored.

This feedback is the training signal for a learned ranker. The two-tower architecture is the production-standard approach for this kind of retrieval problem.

### 6.2 Two-tower architecture

The architecture has two parallel neural networks ("towers"):

**Query tower** — encodes the context: which user is browsing, what filters they have set, what time of day, what signal types they recently engaged with, what entities they recently interacted with.

**Candidate tower** — encodes each candidate entity or signal: its graph embedding (from Component B), its explicit attributes, its recency, its match-outcome history.

At inference time:
1. The query tower computes a query embedding from current context
2. The candidate tower's embeddings are precomputed (refreshed daily or hourly)
3. Retrieval finds top-K candidates by cosine similarity (using Component A)
4. Optional re-ranking step (heavier model) reorders the top-K based on additional features

**Training:**
- Positive examples: (query, candidate) pairs where the user clicked or converted
- Negative examples: (query, candidate) pairs where the user dismissed or ignored
- Loss: binary classification (clicked vs. not), or pairwise ranking (clicked > dismissed)
- Cadence: daily retraining as match-outcome data accumulates

### 6.3 Why two-tower vs. simpler alternatives

**Why not just heuristics?** Heuristics don't improve with data. Two-tower architectures learn from match-outcome feedback and improve continuously. Once the architecture is in place, every user action makes the system smarter.

**Why not single-tower / direct ranker?** Single-tower architectures rerank a small candidate set. They work for re-ranking but not for retrieval over the full entity space. Procur has 100K+ entities; retrieval needs to find the top 100 candidates in <100ms, which requires the precomputed candidate embeddings of two-tower.

**Why not LLM-based ranking?** LLM ranking is too slow and expensive for the match-queue use case (sub-second latency required, called frequently). LLM ranking has a place in re-ranking the top-10 results for high-value queries; not for the full retrieval step.

### 6.4 Implementation effort

7-10 days for working Component C, gated on Components A and B:
- Days 1-3: Two-tower architecture in PyTorch, query tower feature engineering, candidate tower integration with Component B embeddings
- Days 4-6: Training pipeline using match-outcome feedback as labels, evaluation metrics (precision@10, recall@100, NDCG)
- Days 7-8: Production serving infrastructure (precompute candidate embeddings, query-time inference, integration with match-queue API)
- Days 9-10: A/B testing infrastructure to compare learned ranker against heuristic baseline, gradual rollout

---

## 7. Component D — Entity resolution and attribute prediction

### 7.1 Entity resolution use case

When new signals arrive (news article, customs record, regulatory filing), they mention entities by various names: "JBC Bauxite," "Jamaican Bauxite Corporation," "Jamaica Bauxite Co.," "JBC." Entity resolution maps these mentions to the canonical entity in known_entities.

Current procur likely uses string matching with normalization. This works for clean data but fails on:
- Aliases not in the alias table
- Foreign-language mentions
- Partial mentions ("the Jamaican bauxite producer")
- Subsidiary mentions that should resolve to parent

Graph embeddings improve this:
1. Extract candidate entity mentions from incoming signal (existing NLP pipeline)
2. For each mention, generate a candidate embedding from its name + context
3. Find top-10 nearest known_entities by cosine similarity
4. Apply additional resolution logic (geographic plausibility, entity-type match, recency of last mention)
5. Either resolve to existing entity or flag as new entity candidate

### 7.2 Attribute prediction use case

When a partial-information entity enters known_entities (mentioned in a signal but with no segment, scale, or geographic classification), predict missing attributes from graph position:
1. Compute entity's embedding via inductive GraphSAGE inference
2. Find K nearest existing entities with full attribute data
3. Aggregate attributes from neighbors (weighted by similarity)
4. Output predicted attributes with confidence scores
5. Surface to user for validation, with the option to accept/reject predictions

This dramatically reduces the manual curation burden for new entities.

### 7.3 Implementation effort

5-7 days for working Component D, gated on Components A and B:
- Days 1-3: Entity resolution pipeline integrating embedding similarity with existing string matching
- Days 4-5: Attribute prediction pipeline, surfacing predicted attributes in entity profile UI
- Days 6-7: Validation against historical entity additions, calibration of confidence thresholds

---

## 8. Implementation sequencing

The recommended end-to-end sequence:

**Phase 1 (Weeks 1-2): Component A — Vector store foundation**
Independent of all other components. Ships with placeholder embeddings to validate API surface and integration patterns.

**Phase 2 (Weeks 3-5): Component B — Graph embedding training**
Replaces placeholder embeddings with real graph-derived embeddings. Most engineering-intensive phase. Validates entire ML layer end-to-end.

**Phase 3 (Weeks 6-7): Component C — Two-tower match-queue**
Builds on Components A and B. Visible commercial impact: the match-queue starts surfacing better-ranked signals. Establishes the feedback loop where match-outcome data improves the system over time.

**Phase 4 (Weeks 8-9): Component D — Entity resolution and attribute prediction**
Builds on Components A and B in parallel with Phase 3 if engineering capacity allows. Reduces manual entity curation burden, accelerates the rate at which new signals turn into actionable intelligence.

**Total estimated implementation: 7-9 weeks of focused engineering for full ML layer.**

This is a meaningful investment. It should not start until:
- Procur's data graph has accumulated enough observations to make graph embeddings useful (current state likely sufficient already given the brief stack work shipped in PRs #346-350 and the buyer rolodex foundation)
- The match-queue feedback loop (PR #309) has accumulated several months of match-outcome data (current state may be insufficient; verify before starting Phase 3)
- Commercial validation exists for the manual versions of these capabilities — i.e., users actively want better entity matching and attribute prediction, not hypothetical demand

---

## 9. Open-source libraries and references

**Core libraries (production-validated):**
- **PyTorch Geometric (pyg-team/pytorch_geometric)** — GraphSAGE implementation
- **pgvector (pgvector/pgvector)** — Postgres vector extension
- **FAISS (facebookresearch/faiss)** — ANN search (used inside or alongside pgvector)
- **PyTorch Lightning (Lightning-AI/lightning)** — training loop framework
- **MLflow (mlflow/mlflow)** — experiment tracking
- **Microsoft Recommenders (microsoft/recommenders)** — reference implementations of LightFM, NCF, BPR for the two-tower work

**Reference papers:**
- Hamilton et al., "Inductive Representation Learning on Large Graphs" (GraphSAGE), NeurIPS 2017
- Ying et al., "Graph Convolutional Neural Networks for Web-Scale Recommender Systems" (PinSage), KDD 2018
- El-Kishky et al., "TwHIN: Embedding the Twitter Heterogeneous Information Network for Personalized Recommendation," KDD 2022
- Satuluri et al., "SimClusters: Community-Based Representations for Heterogeneous Recommendations at Twitter," KDD 2020
- Grbovic and Cheng, "Real-time Personalization using Embeddings for Search Ranking at Airbnb," KDD 2018
- Covington et al., "Deep Neural Networks for YouTube Recommendations," RecSys 2016 (two-tower retrieval architecture)
- Yang et al., "Mixed Negative Sampling for Learning Two-tower Neural Networks in Recommendations," WWW 2020

**Reference implementations to study (not direct dependencies):**
- twitter/the-algorithm — SimClusters and Heavy Ranker source code
- Twitter's open-sourced ml-metal — production ML serving patterns
- Pinterest's PinSage paper supplementary materials

---

## 10. Architecture decisions deferred to implementation time

These choices should be made when implementation starts, not in advance:

**Embedding dimension.** 128 is the recommended starting point. Tune to 64 (smaller, faster) or 256 (larger, more expressive) based on validation metrics during Component B training.

**Heterogeneous graph treatment.** Start with shared GraphSAGE aggregators across all node types (simpler). Move to type-specific aggregators (TwHIN-style) only if validation shows shared aggregators underperforming on specific node types.

**Negative sampling strategy.** Start with uniform random negative sampling. Move to mixed negative sampling (hard negatives + random) if Component C validation shows bias toward easy candidates.

**Re-ranking layer in Component C.** Start with pure two-tower retrieval (no re-ranker). Add re-ranker only if production data shows top-10 retrieval quality is the bottleneck (vs. retrieval recall).

**Cold-start strategy for new entities.** Two options: (a) inductive GraphSAGE inference with whatever neighborhood the new entity has, returning low-confidence embeddings. (b) Attribute-only embeddings as fallback when graph neighborhood is too sparse. Implement (a) first; add (b) if cold-start performance is unacceptable.

**LLM-augmented re-ranking for high-value queries.** Defer to v2 of the ML layer. Adds complexity and latency; warranted only after v1 establishes baseline performance.

---

## 11. What this brief deliberately doesn't include

- LLM fine-tuning specifics (separate concern from graph ML; addressed in chat tool work)
- Realtime feature engineering pipelines (Component C as specified uses precomputed candidate embeddings; realtime feature work is a v2 concern)
- Multi-modal embeddings combining text, structured, and graph features (v2 if needed; v1 stays graph-focused)
- Federated learning across vex and procur (architecturally interesting, not commercially validated; defer)
- Causal inference for match-queue counterfactual analysis (research-grade, not production-ready)
- Specific A/B testing infrastructure (use existing procur infrastructure or add minimal needed)

---

## 12. Discipline note for implementation

When this brief gets executed, it will be in collaboration with Claude Code or similar agentic coding assistance. Three reminders for the implementation work:

**(1) Components A is a hard prerequisite.** Don't try to build B/C/D against placeholder vector storage. The schema and API surface need to be production-grade before downstream work begins.

**(2) Match-outcome feedback data is required for Component C.** Verify the data is sufficient before starting Phase 3. If insufficient (less than ~10K labeled outcomes), spend time on data accumulation before model training.

**(3) Don't ship learned ranking to production silently.** Component C should ship behind A/B testing infrastructure from day one. The learned ranker should be compared against the heuristic baseline on held-out users for at least 2 weeks before becoming the default. Premature replacement of the heuristic baseline can degrade user experience while feedback signal accumulates.

---

End of brief.
