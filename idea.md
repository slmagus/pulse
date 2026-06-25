PROJECT PLAN
Multi-Agent Bank Stress-Test Simulator
Simulating institutional behaviour under historic and synthetic financial shocks

Version 0.1 — Draft for review	Prepared: June 2026

Contents
1. Executive Summary	3
2. Prior Work & Research Frontier	4
2.1 Classical agent-based stress testing (mature)	4
2.2 LLM-empowered economic agents (emerging)	4
2.3 The closest precedent	4
2.4 Empirical anchors for validation	4
2.5 The central unsolved problem: behavioural fidelity	5
2.6 Where this project contributes	5
2.7 Key references	5
3. Objectives & Success Criteria	7
3.1 Primary objectives	7
3.2 Success criteria	7
4. Scope	7
4.1 In scope	7
4.2 Out of scope (initial release)	7
5. Conceptual Architecture	9
5.1 The agent taxonomy	9
5.2 Tiered agency	9
6. Scenario Engine	10
6.1 Historic replay	10
6.2 Synthetic generation	10
6.3 Contagion channels	10
7. Technical Architecture	12
7.1 Layers	12
7.2 Design decisions worth flagging early	12
8. Phased Delivery Roadmap	13
Phase 0 — Foundations	13
Phase 1 — Single agentic bank	13
Phase 2 — Multi-agent population & network	13
Phase 3 — Scenario engine & validation	13
Phase 4 — Scale, observability & reporting	13
9. Validation & Calibration	14
10. Risks & Mitigations	14
11. Open Questions	14


1. Executive Summary
Goal. Build a simulation environment in which a population of AI agents represents the actors in a banking system — individual banks, depositors, wholesale counterparties, the central bank, and the surrounding market — and observe how that system behaves when subjected to financial shocks. Shocks come in two flavours: historic replays (2008 global financial crisis, the March 2020 COVID liquidity shock, the 2023 SVB / regional-bank runs) and synthetic events (parametrically generated or model-authored scenarios that have no historical precedent).
Why agents. Traditional stress testing (CCAR/DFAST-style) applies a fixed macroeconomic scenario to static balance sheets and reads off the capital impact. It captures the first-order hit but not the reflexive dynamics — herding, confidence-driven runs, fire sales, and counterparty contagion — that turn a shock into a crisis. Agentic actors that make their own funding, lending, and liquidation decisions let these emergent dynamics arise endogenously rather than being assumed.
Core design principle. Not every actor needs a frontier model. A tiered-agency architecture assigns reasoning capacity by an actor's strategic blast radius: mechanical actors run on rules, mid-complexity actors run on small local models, and the systemically important decision-makers run on frontier models. This keeps a system of thousands of agents tractable and affordable.

2. Prior Work & Research Frontier
This project is not inventing a field. It integrates two mature but largely separate research streams — classical agent-based stress testing and LLM-empowered economic agents — at a scale and level of coupling that neither side has yet reached, in a domain where the regulator has already published both the methodology and the empirical validation data. This section situates the work and identifies where it makes an original contribution.
2.1 Classical agent-based stress testing (mature)
A substantial literature on heterogeneous-agent models of financial stability has developed over roughly fifteen years. The standard reference (Aymanns, Farmer et al.) argues these models complement rather than replace equilibrium models, capturing out-of-equilibrium phenomena — fat tails, clustered volatility, fire-sale spirals — that static methods miss. US regulators seeded the field directly: the Office of Financial Research published Bookstaber's foundational work on agent-based models as a tool for analysing threats to financial stability, framing the key actors as funding providers, the leveraged, and liquidity providers.
This stream established the three contagion channels carried into Section 6 of this plan — counterparty loss, overlapping portfolios (fire sales), and funding — and more recent work couples them to the real economy, finding that production-network disruption can amplify interbank contagion materially. Its limitation is precisely this project's opportunity: agent behaviour in these models is hard-coded or stylised. The decision logic is an assumption, not an emergent property.
2.2 LLM-empowered economic agents (emerging)
The conceptual root is Horton's homo silicus (2023): endow a language model with information and preferences and treat it as a simulated economic actor. The landmark application is EconAgent (ACL 2024), which equips LLM agents with perception, memory, and reflection modules and shows they produce more realistic macroeconomic dynamics than rule-based or learning-based agents — directly addressing the agent-heterogeneity problem that constrained classical ABMs. This builds on the generative-agents line (Park et al., 2023) demonstrating believable individual and social behaviour from memory-backed LLM agents.
2.3 The closest precedent
Rajan & Ruaño, Social Contagion and Bank Runs: An Agent-Based Model with LLM Depositors (2026), is effectively a single-slice prototype of this project. They place LLM depositors on a social-media-tuned network over a cash-first, fire-sale balance-sheet block, and report a sharp phase transition in cross-bank failure risk as information spillover rises, with the model reproducing the observed SVB–First Republic ordering of failures and higher run rates among uninsured depositors. Two design lessons carry directly into this plan: they do not fine-tune the model — they constrain it to a strict action interface and validate against laboratory coordination evidence — and they found that attempts at tuning actually reduced behavioural realism. A parallel multi-agent model studies trust and liquidity under payment-system stress.
2.4 Empirical anchors for validation
The validation backbone already exists in the public record. The FDIC's day-by-day study of the 2023 failures found that depositors with substantial uninsured balances were far more likely to run than insured retail depositors (uninsured deposits were 94% of the total at SVB), and that the largest depositors left fastest. The Federal Reserve's own Financial Stability Report identified the novel mechanism this simulator is built to capture — social media and messaging apps synchronising perceived concerns among uninsured depositors, with technology enabling near-instant outflows. High-frequency studies (Cipriani et al.; Cookson et al.) quantify the run-like outflows across roughly two dozen banks and the catalytic role of social platforms. These are the calibration targets for the historic-replay mode.
2.5 The central unsolved problem: behavioural fidelity
LLM agents are systematically too rational — and this is the crux for a stress simulator, because crises are driven by the very behaviours these models most reliably miss. A growing body of experimental-finance work (2025–26) finds off-the-shelf LLM agents fail to reproduce emotion-driven biases: they exhibit a reversed disposition effect, retreat rationally even when prompted for FOMO, and populate markets that look more rational than human-subject experiments. The proposed explanation is that prescriptive training corpora ('cut losses', 'avoid hype') override persona-level instructions. For panic, herding, and fire-sale dynamics, this elevates the validation workstream (Section 9) from good practice to a precondition for credibility.
A reflexive risk worth modelling explicitly. A 2025 Federal Reserve working paper on the financial-stability implications of generative AI finds LLMs herd, favour large-cap and contrarian positions, and carry demographic biases. As real banks deploy LLM agents, model monoculture itself becomes an endogenous source of correlated behaviour and fragility — a scenario this simulator is unusually well-placed to model, rather than merely a caveat about its method.
2.6 Where this project contributes
Mapping the gaps onto the delivery plan:
Scale and integration — the genuine white space. Classical ABMs have rich balance sheets but scripted beliefs; LLM ABMs (including the bank-run precedent) have rich beliefs but thin balance sheets and only a handful of banks. Coupling a full network/accounting layer to an LLM belief-contagion layer at 50+ banks has not been done. The tiered-agency architecture (Section 5.2) is the tractability mechanism that makes it feasible, and is the core differentiator.
Behavioural calibration of LLM panic without overfitting — an actively unsolved problem; constrain-and-validate is the current best practice, not fine-tuning.
Validation standards. No agreed tolerance exists for what counts as 'reproducing' a historical crisis. Defining one is itself a contribution.
Synthetic / model-authored tail scenarios (Section 6.2) are largely unexplored in the literature.
Reflexivity — agents modelling AI-driven institutions. Simulating a banking system in which the institutions themselves run AI is a frontier nobody has built.
2.7 Key references
Aymanns, C., Farmer, J. D., Kleinnijenhuis, A. M., Wetzer, T. Models of Financial Stability and Their Application in Stress Tests. Handbook of Computational Economics, 2018.
Bookstaber, R. Using Agent-Based Models for Analyzing Threats to Financial Stability. OFR Working Paper #0003, 2012.
Bookstaber, R., Cetina, J., Feldberg, G., Flood, M., Glasserman, P. Stress Tests to Promote Financial Stability. OFR Working Paper #0010, 2013.
Horton, J. J. Large Language Models as Simulated Economic Agents: What Can We Learn from Homo Silicus? NBER Working Paper 31122, 2023.
Li, N., Gao, C., Li, Y., Liao, Q. EconAgent: Large Language Model-Empowered Agents for Simulating Macroeconomic Activities. ACL 2024 (arXiv:2310.10436).
Park, J. S., et al. Generative Agents: Interactive Simulacra of Human Behavior. 2023.
Rajan, S., Ruaño, C. Social Contagion and Bank Runs: An Agent-Based Model with LLM Depositors. 2026 (arXiv:2602.15066).
Garcia, J. Homo Silicus is Hyper-Rational: Why LLM Agents Fail to Replicate Attention-Driven Trading. SSRN 5901742, 2025.
Board of Governors of the Federal Reserve System. Financial Stability Implications of Generative AI. FEDS Working Paper 2025-090.
Board of Governors of the Federal Reserve System. Financial Stability Report — Funding Risks. May 2023.
Federal Deposit Insurance Corporation. Study of the 2023 Bank Failures (day-by-day depositor behaviour). 2024.
Cipriani, M., et al. (2024); Cookson, J. A., et al. (2023) — high-frequency deposit-flow and social-media analyses of the March 2023 runs.
Acemoglu, D., Ozdaglar, A., Tahbaz-Salehi, A. Systemic Risk and Stability in Financial Networks. American Economic Review, 2015.
Diamond, D. W., Dybvig, P. H. Bank Runs, Deposit Insurance, and Liquidity. Journal of Political Economy, 1983.

3. Objectives & Success Criteria
3.1 Primary objectives
1. Reproduce known crises. Demonstrate that the agent population, given the historical trigger, reproduces the observed dynamics of at least three reference events (e.g. the 2008 interbank freeze, the 2023 deposit run).
2. Generate novel scenarios. Author synthetic shocks via a parametric shock vector and an optional model-driven narrative generator, and run them to completion.
3. Surface emergent risk. Identify contagion paths, tipping points, and second-order failures that a static scenario would miss.
4. Stay tractable. Run a system of 50+ heterogeneous bank agents plus a depositor/counterparty population at acceptable cost and wall-clock time through tiered agency.
3.2 Success criteria
Dimension
Target
Fidelity
Reference-event replays reproduce the direction and rough magnitude of observed outcomes (failures, funding spreads, asset-price moves) within validated tolerance.
Reproducibility
Any run is bit-for-bit replayable from a seed + scenario manifest, despite stochastic model calls.
Scale
50+ bank agents and ≥10k depositor/counterparty actors per run.
Cost control
Per-run model spend stays within a configured budget, enforced at the gateway.
Explainability
Every agent decision is logged with its inputs, rationale, and resulting balance-sheet action.
4. Scope
4.1 In scope
Agent population: banks, retail and institutional depositors, wholesale/interbank counterparties, a central-bank/regulator agent, and a market/sentiment layer.
Balance-sheet kernel: per-bank assets, liabilities, capital, and the liquidity/solvency metrics that drive decisions (LCR, NSFR, CET1, leverage ratio).
Contagion channels: funding/liquidity, fire-sale/asset-price, interbank counterparty (network), and information/confidence.
Scenario engine: historical replay + synthetic generation, with a shared shock-vector schema.
Validation harness: backtesting against reference events and sensitivity analysis.
4.2 Out of scope (initial release)
Full general-equilibrium macroeconomic modelling of the real economy — the macro path is an exogenous input, not endogenously simulated.
Use as an official regulatory capital-adequacy determination. This is a research and exploration tool, not a submission engine; outputs are directional, not certified.
Real customer or supervisory data. The initial build uses synthetic or public balance-sheet data only.

5. Conceptual Architecture
5.1 The agent taxonomy
The system is a population of heterogeneous agents interacting through a shared, event-sourced market state. Each agent observes the part of the world it can see, decides, and acts; the kernel resolves actions into state changes and prices, then advances the clock.
Actor
Role in the system
Decisions it makes
Bank
The core balance-sheet entity. Heterogeneous in size, asset mix, funding profile, and capital.
Set deposit rates, sell/hold securities (AFS/HTM), draw credit lines, cut lending, tap the central-bank facility, raise capital.
Retail depositor
Sticky funding base, but subject to confidence shocks and herd behaviour.
Stay, withdraw, or move deposits based on perceived safety and peer behaviour.
Institutional / wholesale counterparty
Provides short-term funding (repo, CP, interbank). First to flee.
Roll, reprice, or pull funding; widen haircuts; cut counterparty limits.
Central bank / regulator
Lender of last resort and rule-setter.
Open/adjust liquidity facilities, intervene, resolve or backstop a failing bank, change the macro path.
Market / sentiment layer
Aggregates prices, news, and confidence; transmits information contagion.
Update asset prices from net order flow; propagate signals and rumours.
Rating / information agent
Optional. Issues downgrades that trigger covenants and collateral calls.
Re-rate banks based on observed stress.
5.2 Tiered agency
Reasoning capacity is assigned by an actor's strategic blast radius — how much a single decision moves the whole system. This is the lever that makes thousands of agents affordable.
Tier
Implementation
Who runs here
Why
Tier 0
Behaviour trees / rules
Clearing & settlement, mark-to-market, margin & covenant triggers, the bulk of retail depositors (statistical).
Deterministic, mechanical, must run millions of times. No reasoning needed.
Tier 1
Local 7–8B model
Mid-size banks on routine decisions; institutional counterparties; smaller actors.
Needs some context-sensitive reasoning, but runs at population scale. Cheap and parallel.
Tier 2
Frontier model (Bedrock / Claude)
Systemically important banks under stress; the central-bank/regulator; sophisticated strategic actors.
Complex reasoning over the full board state, where decision quality materially changes the outcome.
Promotion under stress. An actor can move up a tier when conditions warrant — e.g. a mid-size bank normally on Tier 1 is promoted to a frontier model once its LCR breaches a threshold, because at that point its decisions become systemically interesting. This concentrates expensive reasoning exactly where and when it matters.

6. Scenario Engine
Both scenario types compile down to a common shock-vector schema so the simulation kernel is agnostic to where a scenario came from.
6.1 Historic replay
A reference crisis is encoded as (a) an initial system configuration — the balance sheets, exposures, and network as they stood on the eve of the event — and (b) an exogenous trigger timeline. The simulator then runs forward and we observe whether the agent population reproduces the known emergent behaviour. This is the credibility backbone: if the sim can't reproduce a crisis we already understand, its synthetic predictions aren't trustworthy.
Reference event
Trigger encoded
Dynamic we expect to emerge
2008 Global Financial Crisis
Subprime write-downs; a major dealer failure injected on its real date.
Interbank funding freeze, counterparty contagion, flight to quality.
COVID-19, March 2020
Simultaneous dash-for-cash across asset classes; macro shock.
Liquidity spiral, fire sales, central-bank facility takeup.
2023 SVB / regional banks
AFS unrealized-loss disclosure + concentrated, digitally-coordinated depositors.
A fast (sub-week) deposit run and confidence contagion to peers.
Optional: 1998 LTCM, 2011 EU sovereign
Leverage unwind / sovereign-spread shock.
Deleveraging cascade; sovereign-bank doom loop.
6.2 Synthetic generation
Synthetic scenarios are produced two ways, which can be combined:
Parametric. An analyst defines a shock vector directly: a rate path, a deposit-beta / outflow assumption, an asset-correlation regime, a counterparty-default set, or a novel operational/cyber trigger (e.g. a multi-day outage at a core service provider).
Model-authored. A frontier model is prompted to invent a plausible, internally-consistent crisis narrative — a chain of events with no historical precedent — and then translate it into the same shock-vector schema. This is where genuinely novel tail risks come from.
Guardrail. Model-authored scenarios are reviewed for plausibility before being run at cost, and every scenario — however generated — is stored as a versioned manifest so it can be re-run and audited.
6.3 Contagion channels
A shock becomes a crisis through transmission. Four channels are modelled, and their interaction is the point:
5. Funding / liquidity: a stressed bank loses wholesale funding, forcing it to raise rates or sell assets.
6. Fire-sale / asset-price: forced selling depresses prices, marking down everyone else holding the same assets — a feedback loop.
7. Interbank counterparty: losses propagate along the exposure network; one failure impairs its creditors.
8. Information / confidence: observed stress (or a rumour) at one bank shifts depositor and counterparty behaviour at others, independent of any real exposure. This is the channel that LLM agents capture far better than equation-based models.

7. Technical Architecture
7.1 Layers
Layer
Responsibility
Candidate components
Simulation kernel
Event-sourced world state, time advance, action resolution, price formation, reproducible seeding.
Custom discrete-event core; append-only event log.
Balance-sheet & metrics
Per-bank accounting and the liquidity/solvency metrics that drive decisions.
Deterministic financial model (Tier 0).
Agent orchestration
Spawning, scheduling, and message-passing across the agent population; tier routing.
Multi-agent orchestration platform (e.g. Agor); per-tier executors.
Model serving
Frontier and local inference behind one interface, with budget and rate enforcement.
Frontier via Bedrock; local 7–8B via vLLM; LiteLLM gateway in front of both.
Scenario & manifest
Authoring, compiling, versioning, and storing scenarios.
Shock-vector schema; manifest store.
Observability & reporting
Decision logs, contagion graphs, run dashboards, CCAR-comparable summaries.
Trace store; dashboard; export.
7.2 Design decisions worth flagging early
Reproducibility vs. stochastic models. Frontier and local model calls are non-deterministic. The kernel must capture every model input/output in the event log so a run replays exactly from its manifest + seed, even if the underlying model is later unavailable. Treat each model response as a recorded oracle.
Cost is a first-class constraint. A single multi-agent run can issue millions of model calls. Budget enforcement at the gateway is load-bearing, not a nicety — a runaway run must be capped, not discovered after the bill. (Worth validating the gateway's budget-enforcement behaviour against known edge cases before relying on it.)
Time model. Decide up front between discrete fixed steps (e.g. daily) and event-driven advance. Fast runs like the 2023 deposit run argue for sub-daily resolution during acute phases.
Determinism in the kernel, stochasticity at the edges. Keep accounting, clearing, and price formation deterministic; isolate randomness to agent decisions and exogenous shocks so behaviour is attributable.

8. Phased Delivery Roadmap
Each phase ends in something runnable and verifiable, so risk is retired early. Indicative sizing is in relative effort, not committed dates.
Phase 0 — Foundations
Goal. A deterministic simulator with no agency: validate the accounting and the kernel.
Event-sourced kernel, seeding, and replay.
Balance-sheet model and metrics (LCR, NSFR, CET1) for a single bank.
A scripted shock passes through and produces correct, hand-checkable balance-sheet impact.
Phase 1 — Single agentic bank
Goal. One frontier bank agent reacts to a scripted market via tool use.
Bank agent with tools to act on its balance sheet (sell, borrow, reprice, draw facility).
Decision logging with rationale.
Sanity check: the agent makes defensible choices under a simple liquidity squeeze.
Phase 2 — Multi-agent population & network
Goal. A heterogeneous population with contagion.
Heterogeneous banks; Tier 0 depositors and Tier 1 counterparties; central-bank agent.
Interbank exposure network and the four contagion channels.
Tier routing and stress-based promotion.
Phase 3 — Scenario engine & validation
Goal. Historic replay and synthetic generation, calibrated against reality.
Shock-vector schema; historic replays for the reference events; synthetic generator.
Validation harness: backtest replays, compare emergent dynamics to the observed record, sensitivity analysis.
Calibration loop to bring replays within tolerance.
Phase 4 — Scale, observability & reporting
Goal. Production hardening and decision-useful output.
Scale to 50+ banks and ≥10k actors; performance and cost tuning.
Contagion-graph visualisation, run dashboards, CCAR-comparable summaries.
Run governance: manifests, audit trail, access control.

9. Validation & Calibration
Because the tool's value rests entirely on whether anyone should believe its synthetic outputs, validation is treated as a primary workstream rather than a final gate.
Backtesting. Replay each reference event and check that the population reproduces the observed direction and rough magnitude of outcomes — failures, funding-spread widening, deposit outflows, facility takeup.
Sensitivity analysis. Sweep key parameters (deposit beta, haircut severity, network density) and confirm the system responds monotonically and without unexplained cliffs.
Cross-check against established methods. Compare first-order capital impacts to a static CCAR/DFAST-style calculation on the same scenario; the agentic run should agree on the static hit and then add the dynamic overlay.
Ablation. Turn contagion channels off one at a time to attribute how much of an outcome each channel drives.
10. Risks & Mitigations
Risk
Mitigation
Garbage-in fidelity — agents behave plausibly but unrealistically, producing confident nonsense.
Anchor everything to reference-event backtests; treat un-validated synthetic outputs as hypotheses, not forecasts.
Cost blow-up from millions of model calls.
Tiered agency, gateway budget enforcement with hard caps, and local models for the population tier.
Non-reproducible runs due to stochastic models.
Record every model I/O in the event log; replay from manifest + seed.
Over-interpretation — results mistaken for regulatory truth.
Explicit scoping as a research tool; directional language; no certified outputs.
Combinatorial complexity makes runs intractable.
Discrete-event time, promotion only under stress, and aggressive use of Tier 0 for mechanical actors.
Calibration overfitting to historic events.
Hold out at least one reference event from calibration and validate against it blind.
11. Open Questions
9. What is the source of initial balance-sheet and network data — public regulatory filings, synthetic generation, or a hybrid?
10. Fixed-step vs. event-driven time, and what temporal resolution the acute phase of a run requires.
11. How much of the depositor population can be purely statistical (Tier 0) before confidence-contagion fidelity degrades.
12. Acceptance tolerance for a replay to count as 'reproducing' a reference event.
13. Whether the central-bank/regulator agent is adversarially co-designed or scripted in the first release.