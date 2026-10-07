---
title: "Manifesto"
description: "Why Gluon exists and what it is for."
---

Gluon is a CLI control platform for coding agents. It helps engineers do two things: choose the most cost-effective agent for each session, and manage their agents' sessions with visibility into cost and context. For the first, an intake agent works out the goal of a session with you, writes it up as a spec, then launches the right agent.
 
Two terms first. A **session** is what an engineer does when they interact with a coding agent. It is the unit Gluon decides on, not the task: one session can cover reading code, making an edit, running tests and debugging a failure. An **agent** is **harness × model × effort**, and Gluon adds a **mode** (explore, plan or build). We treat the session as the unit of work and the agent, not the model, as the unit you choose for it.
 
## What we believe
 
### 1. We bet on engineers
 
As agents grow more capable, they will take on more of the work inside a session, from exploring to planning to building, and engineers will do more of the managing and steering: setting the goal, choosing the agent, watching sessions and deciding when to redirect. We are long on that role. Gluon is built to enable it, not to replace it. Steering takes visibility, so Gluon shows cost and context as sessions run.
 
### 2. We start with a clear ask
 
Much of the cost of working with coding agents comes from a vague goal. The intake agent exists to turn a fuzzy idea into a clear spec before any tokens are spent planning or building.
 
A **spec** is a clear written statement of what the session is for. It is not a plan: it says what to achieve, not how to get there. Working out the how is the agent's job, and in plan mode that produces a plan. Choosing the right agent only pays off once you know what you are asking for.
 
### 3. We match the agent to the session
 
Practitioners should match capability and cost to the job. A session for a small scoped edit and a session for a cross-cutting refactor shouldn't run on the same agent. Running every session on the most capable agent wastes money, and running every session on the cheapest one risks sessions that fail.
 
### 4. We trust harnesses that grow up with their models
 
Model companies work hard to make their models perform well, in capability and in cost, inside their own harnesses. We build on that effort and run those harnesses as they are instead of replacing them.
 
Not every harness belongs to a lab, but the pattern holds. OpenCode is open source and model-agnostic, yet at the time of writing DeepSeek and Meta's Muse Spark models lead its [usage rankings](https://opencode.ai/data), so it ends up shaped around them too.
 
### 5. We keep routing open
 
**Routing** picks the primary agent for a session, the one the engineer runs it with: which harness, from which lab, at what effort. That is Gluon's job, and we route between agents, not models. **Orchestration** is what happens next, inside the harness: the primary agent may bring in subagents for parts of the work.
 
The right routing depends on the user and the organization: budget, trust, existing subscriptions, the codebase. That cannot be hard-coded by a vendor, so we make the routing machinery open. We did our best to keep the defaults general and the configuration easy. See [`routing.yaml`](../reference/index.md).
 
### 6. We want cost and efficiency to be comparable
 
Model companies sell subscriptions that bundle tokens with their harnesses. Early electricity worked in a similar way: it came bundled with the equipment that ran on it, and shared standards, such as common bulb bases and voltages, later made it easier to compare and swap parts. The community should ask for standards on cost and efficiency, so agents can be compared and chosen on evidence.
 
There are early signs this is happening. Benchmarks are starting to report cost next to score: [Artificial Analysis](https://artificialanalysis.ai/agents/coding-agents), [DeepSWE](https://deepswe.datacurve.ai/) and [Terminal-Bench 4.0](https://www.tbench.ai/news/terminal-bench-4-0). Benchmarks compare agents in general, while Gluon's observability and analytics show what your own sessions cost.
 
## Where we think this is going
 
### What we expect
 
We expect model companies to consolidate **effort × model** over time. Today a single vendor can offer several model sizes with several effort levels each, and the combinations multiply. Users do not want to pick from a grid. We expect that to collapse into a small number of **Tiers** on a scale, and not much more. A **Tier** is a single named level that bundles a model and an effort setting, so the user picks a position on one scale instead of turning two separate dials. Sam Altman has [said something similar](https://x.com/tbpn/status/2105059293238354422).
 
We also expect each lab to become best at orchestrating inside its own model family: bringing in the right subagents for the right parts of a session. A lab's harness can see its own models' strengths and costs in a way an outside router cannot. We don't expect labs to change the primary agent the user chose. That choice stays with the user.
 
### What that means for Gluon
 
Whether the ecosystem keeps model × effort or moves to Tiers, Gluon will evolve with it. The important question will stay: how to enable engineers to manage and steer their agents cost-effectively.

<!-- Keeping this file fresh: update when the vocabulary changes (session, agent, mode, spec, routing, orchestration, Tier) or Gluon's stance on routing, harnesses or cost changes. Check src/routing.ts, src/harnesses.ts and docs/concepts/architecture.md. -->
