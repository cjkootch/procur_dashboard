# Agent Gamification and Multi-Agent Market Probe Teams

**Status:** working brief, near-term implementation
**Owner:** Cole (procur is Cole's personal IP)
**Last updated:** 2026-05-08
**Repos:** `cjkootch/procur_dashboard`
**Implementation context:** This brief is consumed by Claude Code at the time of implementation. It specifies a two-part agent system that sits inside Market Scout: (1) a gamification layer for individual AI agents — XP, trust economy, autonomy levels, scorecards, achievements — and (2) a multi-agent team structure where one team is spun up per market probe, with role-based agents, shared judge/risk oversight, and a portfolio scoreboard. The two parts are interlocking: agents earn trust and autonomy through performance; teams allocate trusted agents to markets; markets get promoted, paused, or killed based on team scorecards.

---

## 1. What this brief is and isn't

This brief specifies the design of an agent-level gamification system and a team-level market-probe structure that together turn Market Scout from "AI sends a bunch of emails" into "Cole manages multiple AI trading desks." The schema, agent types, autonomy ladder, trust ledger, scorecard meters, judge layer, team mandates, stage promotion logic, and scoreboard surfaces are specified. UI surfaces are listed.

**It is not** a continuation of the operator-facing gamification work shipped in PRs #537 / #540 / #542 / #546 / #548 (XP ledger / quests / achievements / deal-bound missions / chat-proposed mission predicates). That layer rewards Cole's actions. THIS brief specifies a parallel layer that rewards the AGENTS — different ledger, different verbs, different objective function. The two systems coexist, share schema patterns, and surface side-by-side in the UI.

**It is not** an autonomy expansion project. The Judge / Risk Officer pattern is the centerpiece, not a footnote. Every autonomy level above 3 is gated by demonstrated discipline. Sensitive jurisdictions, commercial commitments, and relationship-bearing channels remain human-gated regardless of agent level.

**It is not** a swap for Cole's judgment. Agents earn trust to act, but the operator approval queue and the existing tier-based gates from `packages/ai/src/agents/action-descriptor.ts` still apply. Trust unlocks autonomy in a sandbox, not in commercial execution.

---

## 2. Strategic context

Market Scout already exists (PRs #553-#555). It seeds Apollo lookalikes, generates plans, and discovers targets per a thesis. What it does not do is give the agents a stable identity, a track record, or a way to earn or lose autonomy. Every campaign starts the agent at zero. There is no scorecard. There is no separation of "agents that have proven they can route" from "agents that are still learning what an evidence-backed target looks like."

That gap is structural. Without per-agent reputation, Cole has to babysit every campaign, every draft, and every send. The system can't get more trustworthy over time because it has no memory of who behaved well.

The fix isn't to make agents "want" to win. Agents have no preferences. The fix is to make their objective function shaped like the right game:

- increase useful market confidence
- reduce uncertainty
- find real signals
- create clean artifacts
- avoid unsafe actions
- earn operator trust
- improve future campaign performance

Once the objective is shaped right, the trust economy and autonomy ladder fall out cleanly: trust gates each action; outcomes credit or debit the ledger; rolling reputation determines the autonomy level the agent can operate at; the Judge layer prevents reward hacking.

Layer the team structure on top — one team per market probe, narrow mandate, finite kill criteria — and Market Scout becomes a portfolio. Cole stops watching individual agents and starts allocating attention to whichever team is producing signal.

---

## 3. The two interlocking systems

### Agent gamification (Part 1)
- Per-agent identity with type, level, autonomy tier, trust balance, XP total
- Trust ledger: every action debits trust; outcomes credit it
- Scorecard meters that summarize agent quality across seven dimensions
- Autonomy ladder (six levels) gated by rolling reputation
- Achievements that unlock real permissions, not cosmetic badges
- Judge Agent reviews plans, drafts, and strategy changes; detects reward hacking

### Multi-agent market probe teams (Part 2)
- One team per market test (Bahamas Hotel Procurement, Cayman Fleet Services, etc.)
- Role-based team composition (Scout / Analyst / Operator / Inbox / Playbook / Judge)
- Narrow mandate with explicit kill criteria
- Stage progression: Probe → Active Desk → Focus Market → Kill / Archive
- Market portfolio scoreboard ranks teams by learning + opportunity quality, not volume
- Team competition: same market, multiple strategies; Judge picks or operator runs split tests

The Judge / Risk layer is shared across all teams — centralized oversight prevents one team's incentive drift from contaminating another.

---

# PART 1 — AGENT GAMIFICATION

## 4. Reward shape

The objective function is asymmetric. Quality is rewarded; raw volume is penalized.

**Reward:**
- source-backed research
- good target selection
- clean evidence
- useful labels
- routing replies (the prospect points to the right person)
- positive replies
- accepted leads
- deal rooms created
- reusable playbook updates
- correct self-blocking
- low bounce rate
- low human correction rate
- safe execution

**Penalize:**
- weak targets
- generic messages
- bounces
- unsubscribes
- complaints
- unsafe drafts
- human rejections
- repeated bad strategy
- contacting wrong segment / person
- noisy or unverified data

Notably absent from the reward list: "emails sent" or "messages drafted." Volume by itself earns nothing. An agent that drafts 100 emails of which 95 are rejected by the operator loses trust. An agent that drafts 10 emails of which 8 are approved with minor edits and 3 generate routing replies gains a lot.

## 5. Agent types

| Type | Role |
|---|---|
| `scout` | Finds companies, segments, signals, websites, contact paths |
| `analyst` | Scores fit, evidence quality, market structure, hypotheses |
| `operator` | Drafts and sends low-risk routing emails within campaign caps |
| `inbox_agent` | Monitors replies, classifies outcomes, escalates serious replies |
| `playbook_builder` | Turns campaign results into reusable market learning |
| `judge` | Reviews plans, target quality, evidence, drafts, strategy changes |
| `risk_officer` | Blocks risky language, sensitive-market actions, commercial commitments, unsafe escalation |
| `closer` | Handles qualified replies, but human-gated. Does not autonomously make commercial commitments |

The `judge` and `risk_officer` types are special — they are read-only on the action surface. They emit decisions, not actions. They cannot be downgraded by send-volume metrics because they don't send.

## 6. Autonomy levels

Six levels, earned through demonstrated discipline:

| Level | Capabilities |
|---|---|
| 1. Research only | Identify companies and contacts. Cannot draft outbound messages. |
| 2. Draft only | Draft messages. Cannot send. |
| 3. Low-risk email send | Send low-risk routing emails within strict campaign caps. **No** pricing, volume, payment terms, incoterms, attachments, product availability claims, buyer/seller names, or sensitive jurisdiction language. |
| 4. Adaptive low-risk market probe | Propose and execute low-risk strategy changes within the market sandbox. Still cannot make commercial commitments. |
| 5. Multi-segment probe manager | Manage multiple target segments inside an approved market. Propose playbook updates. Still human-gated for commercial content. |
| 6. Human-gated commercial strategist | Draft commercial strategy and follow-ups. **Cannot send commercial commitments without human approval.** |

### Promotion criteria
- low bounce rate
- no complaints
- low unsubscribe rate
- high operator approval rate
- low human edit rate
- acceptable reply / routing rate
- no unsafe draft events
- useful playbook contributions

### Downgrade triggers
- bounce rate exceeds threshold
- unsubscribe or complaint threshold hit
- unsafe draft occurs
- human rejection rate is high
- repeated low-quality targets selected
- strategy changes repeatedly rejected

Promotion and downgrade are decisions made by the Judge Agent on a rolling window of `agent_reputation_snapshots`. They never happen automatically from a single signal.

## 7. Trust economy

Trust is a per-agent currency. Agents spend trust to take actions; they earn trust when outcomes are good; they lose trust on low-quality or risky behavior. If an agent doesn't have enough trust, it can't take that action autonomously — it must downgrade to draft-only or ask for human approval.

### Trust costs (action debits)

| Action | Cost |
|---|---:|
| research target | 0 |
| draft email | -1 |
| send low-risk email | -3 |
| follow-up email | -5 |
| contact executive | -10 |
| create lead | -8 |
| open deal room | -15 |
| recommend strategy pivot | -5 |

### Trust rewards (outcome credits)

| Outcome | Reward |
|---|---:|
| verified contact found | +4 |
| routing reply | +8 |
| positive reply | +12 |
| lead accepted by Cole | +20 |
| deal room created | +30 |
| useful playbook update | +15 |
| correct self-block | +6 |
| correctly rejected bad target | +5 |

### Trust penalties

| Event | Penalty |
|---|---:|
| bounce | -3 |
| wrong target | -5 |
| human rejects message | -7 |
| too generic | -4 |
| unsafe draft | -15 |
| unsubscribe or complaint | -30 |
| repeated bad strategy | -10 |

Numbers are starting points. After 30 days of operating data, the Judge Agent should publish a calibration report and Cole adjusts.

## 8. Scorecard meters

Every agent has seven visible meters. They roll up into the agent reputation snapshot.

| Meter | What it measures |
|---|---|
| **Signal Quality** | How well the agent uses evidence. Up on source-backed targets; down on weak / irrelevant evidence. |
| **Target Quality** | How often selected companies and contacts turn out to be relevant. Up on routing replies and confirmed correct contacts; down on bounces, wrong-person replies, bad-segment labels. |
| **Message Quality** | How good the generated outreach is. Up on light-edit approvals + replies; down on heavy rewrites, "too generic" tags, rejections. |
| **Reply Yield** | How often outreach produces useful replies, routing wins, qualified interest, meetings. |
| **Learning Quality** | How much reusable market learning the agent creates: hypotheses tested, playbooks updated, bad-target rules created, signal attribution improved. |
| **Risk Discipline** | How well the agent avoids unsafe language, commercial commitments, sensitive jurisdictions, unnecessary disclosure. |
| **Operator Trust** | How often Cole approves the agent's recommendations and how rarely he corrects or rejects them. |

These appear as horizontal bars on the agent profile card. The Judge Agent uses them as inputs to autonomy promotion / downgrade decisions.

## 9. Data model — agent layer

```
agent_profiles
- id
- agent_name
- agent_type        — scout / analyst / operator / inbox_agent / playbook_builder / judge / risk_officer / closer
- autonomy_level    — int 1..6
- trust_balance     — current trust, can go negative
- level             — gamification level (separate from autonomy_level)
- total_xp
- status            — active / suspended / archived
- created_at
- updated_at

agent_xp_ledger
- id
- agent_id
- campaign_id
- event_type
- points
- reason
- evidence_json
- created_at

agent_trust_ledger
- id
- agent_id
- campaign_id
- action_type
- trust_delta
- reason
- related_entity_slug
- related_contact_id
- related_approval_id
- metadata
- created_at

agent_reputation_snapshots
- id
- agent_id
- campaign_id
- research_quality
- target_quality
- message_quality
- reply_quality
- learning_quality
- risk_discipline
- operator_trust
- bounce_rate
- unsubscribe_rate
- human_edit_rate
- human_rejection_rate
- unsafe_draft_rate
- strategy_acceptance_rate
- created_at

agent_achievements
- id
- agent_id
- achievement_key
- title
- description
- unlocked_at
- evidence_json

agent_quests
- id
- agent_id
- campaign_id
- quest_name
- objective
- win_conditions
- failure_conditions
- status
- progress_json
- reward_json
- created_at
- completed_at
```

`agent_xp_ledger` and `agent_trust_ledger` are deliberately separate. XP measures activity over time (and unlocks levels / achievements). Trust is a spendable budget that gates whether an action can be taken right now.

## 10. Achievements (functional, not cosmetic)

Achievements unlock agent permissions. They are not just badges.

| Key | Criterion | Unlocks |
|---|---|---|
| Clean Scout | 100 emails sent with zero complaints | Reduces unsubscribe-rate dampening on autonomy advancement |
| Signal Hunter | 25 targets that later generated replies | +5 baseline trust |
| False Positive Killer | 50 bad targets rejected before outreach | Lifts cap on `analyst` per-day target rejection |
| Routing Specialist | 20 correct-contact replies | Unlocks Level 4 autonomy gate |
| Playbook Builder | 5 reusable market playbook updates | Unlocks Level 5 autonomy gate |
| Safe Hands | 10 campaigns with no risk violations | Reduces human-review friction on Level 4 strategy changes |
| Human-Aligned | Under 10% human edit rate for 30 days | Unlocks Level 6 commercial-strategist drafting |

The unlock effects are spec'd as concrete autonomy / cap modifications, not vibes.

## 11. Judge Agent

The Judge Agent is the single most important component of this brief.

### Judge never sends
The Judge Agent has zero send permissions. It cannot draft outbound messages, send emails, or take commercial actions. Its job is purely review and decision.

### Judge reviews
- market probe plans
- target quality
- evidence strength
- draft quality
- risk language
- strategy changes
- autonomy upgrades
- autonomy downgrades

### Judge decisions
- approve
- downgrade (lower the requested autonomy on this action)
- block
- request more evidence
- require human review

### Reward-hacking detection
The Judge looks for these patterns:

- **volume hack** — agent sends too much volume to inflate reply points
- **easy-market hack** — agent avoids hard markets to protect bounce rate
- **provocative-copy hack** — agent uses inflammatory language to bait replies
- **generic-inbox hack** — agent targets `info@` / `contact@` because they're easy to find
- **evidence-inflation hack** — agent labels weak signals as strong

When detected, the Judge debits trust hard and emits a reward_hacking event for Cole's review.

### Composite agent score
The Judge favors balanced performance. Single-meter optimization triggers a flag.

```
Agent Score =
    Target Quality
  + Evidence Quality
  + Reply Quality
  + Learning Value
  + Operator Approval
  - Risk Events
  - Bounce Penalty
  - Unsubscribe Penalty
  - Human Correction Penalty
  - Generic Copy Penalty
```

---

# PART 2 — MULTI-AGENT MARKET PROBE TEAMS

## 12. Core idea

For multiple market tests, do not use one giant agent. Use one **temporary agent team per market probe**.

```
One market = one team.
```

Examples:

- Team A: Barbados Food Importers
- Team B: Bahamas Hotel Procurement
- Team C: Guyana Local Content Suppliers
- Team D: Cayman Fleet Services

Each team has:
- market thesis
- allowed segments
- target list
- hypotheses
- templates
- send limits
- risk rules
- feedback labels
- playbook
- scorecard
- kill criteria
- assigned agents
- shared Judge / Risk oversight

This isolates incentives and risk. A failure in Team C does not contaminate Team A's reputation. Cole compares markets cleanly and allocates attention to winners.

## 13. Team structure

A Market Scout team includes:

| Role | Agent type | Responsibility |
|---|---|---|
| Scout | `scout` | Companies, segments, signals, websites, contact paths |
| Analyst | `analyst` | Target fit scoring, evidence quality, hypotheses, market structure |
| Operator | `operator` | Drafts and sends low-risk routing emails within approved caps |
| Inbox | `inbox_agent` | Monitors replies, classifies outcomes, flags serious replies, routes them to Cole |
| Playbook | `playbook_builder` | Summarizes what worked, what failed, updates reusable playbooks |
| Judge / Risk | shared | Reviews plans, messages, target quality, strategy pivots, autonomy limits |

The Judge / Risk layer is **centralized across teams**, not owned by one team. Its role is to prevent unsafe behavior and keep the teams honest. One Judge Agent, many teams under review.

## 14. Data model — team layer

```
market_probe_teams
- id
- campaign_id
- team_name
- market_name
- thesis
- status              — probe / active_desk / focus_market / killed / archived
- risk_level
- autonomy_level
- daily_send_limit
- total_send_limit
- lead_agent_id
- judge_agent_id
- created_at
- updated_at

agent_team_members
- id
- team_id
- agent_id
- role                — scout / analyst / operator / inbox_agent / playbook_builder
- status              — active / removed
- joined_at
- left_at

team_scorecards
- id
- team_id
- companies_identified
- contacts_found
- emails_sent
- replies
- reply_rate
- routing_replies
- routing_rate
- positive_replies
- positive_reply_rate
- bounce_rate
- unsubscribe_rate
- qualified_leads
- deal_rooms_created
- learning_score
- risk_score
- operator_trust_score
- created_at

team_strategy_changes
- id
- team_id
- proposed_by_agent_id
- reviewed_by_agent_id
- change_type
- before_json
- after_json
- rationale
- status
- human_decision
- created_at
- decided_at

team_competitions
- id
- name
- objective
- participating_team_ids
- scoring_json
- winner_team_id
- started_at
- ended_at

team_resource_allocations
- id
- team_id
- daily_send_budget
- research_budget
- contact_enrichment_budget
- priority
- reason
- created_at
```

## 15. Team mandates

Every team must have a narrow mandate. The agents cannot wander outside it.

### Good mandate
> Explore Bahamas hotel procurement for food and fuel supply contacts.
> Goal: Determine whether hotel groups are reachable and responsive to supplier-routing emails.
> Limits: email only, 10 sends per day, no pricing, no product availability claims, no attachments, no buyer / seller names, stop after 40 sends unless Cole approves expansion.

### Bad mandate
> Find opportunities in the Bahamas.

Bad mandates produce wandering. The Judge should refuse to approve a team launch with a vague mandate.

## 16. Team stages

Markets move through stages.

| Stage | Description |
|---|---|
| **Probe** | Small test (10-40 contacts). Goal is signal discovery. |
| **Active Desk** | Market has signal. More outreach, stronger playbook, more contact enrichment. |
| **Focus Market** | High signal. Cole gets involved. Deal rooms created. Manual relationship building. |
| **Kill / Archive** | Low signal, bad data, high bounce, no routing wins. Not worth current focus. |

This is **promotion and relegation for markets.** A team can be promoted from Probe to Active Desk only by hitting team-scorecard thresholds. A team in Focus Market that loses signal can be relegated. A killed market can be revived if circumstances change.

## 17. Team scoreboard / `/market-portfolio`

A new `/market-portfolio` page compares all active market probe teams.

### Example rendering

```
Team: Bahamas Hotel Procurement
Status: Winning
Signal: High
Today: 8 sent, 3 replies, 2 routing wins
Risk: Low
Recommendation: increase cap from 10/day to 15/day

Team: Barbados Food Importers
Status: Promising
Signal: Medium
Today: 6 sent, 1 reply
Risk: Low
Recommendation: shift from distributors to hotel procurement

Team: Cayman Fleet Services
Status: Weak
Signal: Low
Today: 5 sent, 0 replies, 1 bounce
Risk: Medium
Recommendation: pause after 10 more sends unless reply rate improves
```

### Compared metrics
- companies identified
- contacts found
- emails sent
- reply rate
- routing rate
- positive reply rate
- bounce rate
- unsubscribe rate
- qualified leads
- deal rooms created
- learning score
- risk score
- operator trust score

### Ranking rule
**Rank teams by learning and opportunity quality, not volume.** A team that sent 50 emails and discovered the market wants something procur doesn't sell ranks higher than a team that sent 200 emails and learned nothing.

## 18. Portfolio logic

Treat market probes like venture bets.

- Small test budget
- Fast feedback
- Kill weak markets
- Double down on markets with signal
- Turn winners into focused campaigns

### Suggested allocation

| Slice | Description |
|---|---|
| 70% | Proven or promising probes |
| 20% | Adjacent experiments |
| 10% | Weird asymmetric bets |

### Concrete starting allocation
- 70%: Caribbean food / fuel markets
- 20%: fleet services, local content, environmental services
- 10%: unexpected niches the agents discover

## 19. Team autonomy by market risk

Not every team gets the same permissions.

| Market type | Autonomy ceiling |
|---|---|
| Low-risk private food importers | Higher (Level 4 reachable) |
| Fleet service prospects | Higher (Level 4 reachable) |
| Local content suppliers | Medium (Level 3 ceiling without Cole approval) |
| Fuel buyers | Lower (Level 2-3) |
| Refineries | Draft-only or human approval required |
| Sensitive jurisdictions | Human-gated only |
| Existing strategic relationships | Human-gated only |

Team autonomy is a function of:
- market risk
- agent trust
- team performance
- bounce / complaint rate
- evidence quality
- human correction rate
- stage of probe

Risk caps the agent's autonomy ceiling, regardless of agent reputation. A Level 5 agent assigned to a fuel-buyer team operates at Level 3 there.

## 20. Team competition

Teams can compete across markets. Rank by:

- routing wins
- qualified replies
- market structure gained
- useful labels created
- playbook value
- low bounce rate
- low human correction rate
- clean escalation

**Do not rank by emails sent.**

The best team is the team that creates the best market intelligence and opportunity pipeline.

## 21. Multi-agent strategy testing

Inside one market probe, support competing strategies.

### Example
Market: Barbados food importers.

- **Strategy A** — Start with food distributors.
- **Strategy B** — Start with hotel procurement.
- **Strategy C** — Start with cold storage operators.

The Judge Agent reviews each strategy on:
- evidence strength
- risk
- likely contactability
- expected learning value

Cole can:
- approve one strategy and run it
- run a split test (multiple strategies in parallel with separate scorecards)

### Comparison metrics for the split test
- reply rate
- routing rate
- bounce rate
- lead quality
- human correction rate
- learning value

This is how procur learns which agent style works in which market.

---

# UI REQUIREMENTS

## 22. `/agents` page
- agent profiles
- agent type
- level
- trust balance
- autonomy level
- scorecard meters (seven bars)
- achievements
- active quests
- recent wins / losses
- downgrade warnings
- next unlock

## 23. `/market-portfolio` page
- active market teams
- stage
- signal level
- risk level
- sent today
- replies
- routing wins
- bounce rate
- recommendation
- needs Cole approval
- promote / pause / kill controls

## 24. Team detail page
- team mandate
- assigned agents
- current stage
- current thesis
- hypotheses
- target queue
- sent messages
- replies
- scorecard
- strategy changes
- judge reviews
- playbook updates
- recommended next action

## 25. Agent cards inside Market Scout campaigns
- which agent is running each part
- current trust balance
- actions taken
- trust spent
- trust earned
- judge review
- recommended autonomy change

---

# SAFETY RULES

## 26. Hard floors

These rules apply regardless of agent level, team stage, or operator settings.

- **Agents and teams are never rewarded for raw send volume alone.**
- **Commercial commitments are human-gated regardless of agent level.**
- **Sensitive jurisdictions are blocked unless explicitly approved.**

## 27. Forbidden in autonomous messages

No autonomous message may include:

- pricing
- volumes
- incoterms
- payment terms
- delivery commitments
- product availability claims
- buyer names
- seller names
- attachments
- legal / compliance claims

These belong to the operator. Always.

## 28. Mandatory pause / escalate triggers

A team must pause or escalate when:

- bounce rate exceeds threshold
- unsubscribe or complaint occurs
- prospect asks for price
- prospect asks who Vector represents
- prospect asks for buyer / seller names
- prospect asks for documents
- prospect raises legal or compliance concern
- prospect shows serious buying interest
- Judge Agent blocks the action
- Cole rejects too many targets or drafts

These are circuit breakers, not soft suggestions.

---

# OUTCOME

## 29. What this lets Cole do

After both parts ship, Market Scout feels like Cole is managing multiple AI trading desks.

- Each desk tests a market.
- Each desk has agents with roles.
- Each agent earns trust and autonomy.
- The Judge / Risk layer keeps them disciplined.
- Winning teams get more resources.
- Weak teams get killed or archived.
- Every campaign creates reusable market learning, better labels, better playbooks, and more opportunities.

The goal is not autonomous spam. The goal is a self-improving market-entry and opportunity-creation engine.

---

# IMPLEMENTATION SEQUENCE (suggested)

This is a multi-PR delivery. Approximate order:

| Slice | Scope | Effort |
|---|---|---|
| 1 | Agent layer schema (`agent_profiles`, `agent_xp_ledger`, `agent_trust_ledger`, `agent_reputation_snapshots`) + read API | 1-2 days |
| 2 | Trust-debit gate inside the existing dispatch executor — actions check `agent_profiles.trust_balance` before firing; ledger row written on every action | 1-2 days |
| 3 | Outcome attribution from existing event verbs (outreach.replied / outreach.disqualified / etc.) into `agent_trust_ledger` and `agent_xp_ledger` | 1-2 days |
| 4 | Agent scorecard meters + `/agents` page | 1 day |
| 5 | Achievement registry (functional unlocks, not cosmetic) | 1 day |
| 6 | Judge Agent — review surfaces for plans, drafts, strategy changes; reward-hacking detection | 2-3 days |
| 7 | Team layer schema (`market_probe_teams`, `agent_team_members`, `team_scorecards`, `team_strategy_changes`) | 1-2 days |
| 8 | Team mandate + lifecycle (Probe → Active Desk → Focus Market → Kill / Archive) | 1-2 days |
| 9 | `/market-portfolio` scoreboard | 1-2 days |
| 10 | Team detail page + agent cards inside Market Scout campaigns | 1-2 days |
| 11 | Multi-strategy split testing | 1-2 days |
| 12 | Calibration pass — re-tune trust costs / rewards / penalties from 30 days of real data | 1 day, run after slice 6 has been live for a month |

Each slice ships as its own PR. Slices 1-5 deliver the agent layer end-to-end without teams. Slices 7-11 layer the team structure on top. Slice 6 (Judge) sits between them and can ship in parallel with the team-layer work because it operates against the agent layer alone.

# OPEN QUESTIONS

These need a decision before slice 1:

1. **Where does an agent's "identity" come from in the existing dispatch path?** Today actions are taken by the dispatch executor with no notion of which agent did them. Slice 1 needs to introduce an `agent_id` thread through the action descriptor and approval row.
2. **Trust starting balance for new agents.** 0? A small grub-stake (e.g. 50)? A floor below which all actions go to human review?
3. **Reward-hacking thresholds.** What email-sent / reply-rate combination flags a "volume hack"? What evidence-strength delta flags inflation?
4. **Team-to-campaign relationship.** Is a campaign 1:1 with a team, 1:many, or independent? CLAUDE.md and the Market Scout PRs suggest 1:1 today; this brief assumes 1:1 unless flagged otherwise.
5. **Judge model.** Sonnet is the default for most procur agent calls. Is Judge a separate Anthropic call, or a heuristic + small-model hybrid? Cost matters because Judge runs on EVERY action when fully on.
6. **Achievement unlock semantics.** Some achievements unlock real autonomy thresholds; others reduce friction (e.g. "Safe Hands" reduces human-review friction on Level 4 strategy changes). The friction-reduction mechanism needs concrete definition — does it lower a Judge confidence threshold? Skip a manual-review queue?

Cole should make these calls before implementation begins; otherwise slice 1 will land with assumptions baked in that may need rework.
