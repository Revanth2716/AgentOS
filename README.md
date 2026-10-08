# AgentOS — Local-First AI Agent Control Plane

AgentOS is a local-first control plane for autonomous agents: a single Node.js
server that owns the registry, the tool and policy governance, the execution
loop, the event trace, human approvals, workflow orchestration, evaluations,
metrics, and cost accounting. The dashboard and API live on the same HTTP
port. The whole system runs offline by default using a deterministic mock
provider, a synthetic corpus, and a local SQLite database, so iteration is
zero-cost and reproducible on a laptop.

It exists because standalone agents are easy to start and hard to operate.
Something has to decide which tools an agent may call, what happens when a
tool is dangerous, how a run is traced and replayed, how a workflow with
multiple specialized agents is orchestrated, how humans approve risky actions,
and how the operator tells whether the agent quality is actually improving.
AgentOS is the layer that answers those questions with one consistent runtime
instead of ad-hoc scripts around raw API calls.

---

## What exists today

AgentOS is a working local system, not a hosted product. These pieces are
implemented in this repository:

- **Agent registry** — create, update, disable, and version agents. Agent
  specs are validated with Zod and stored in SQLite; every mutation is recorded
  in an audit log and each agent has a version history.
- **Tool registry** — builtin tools, browser tools, and MCP-discovered tools all
  flow through one registry. Tools carry a kind, risk level, permission
  requirements, and an input schema. The server mirrors registered tool metadata
  into its tools table for the UI.
- **Policy engine** — deterministic, auditable policy decisions made from
  structured inputs: agent identity, tool name, argument digest, policy config,
  stored rules, and prior call counts. Verdicts are `allow`, `deny`,
  `require_approval`, or `rate_limited`. Prompt injection cannot change them.
- **Bounded runtime loop** — `TASK → PLAN → TOOL CALL → OBSERVE → DECIDE → … →
  FINAL`. Every transition is persisted as a run event with a monotonic
  sequence number. Hard limits enforce termination: max steps, max runtime,
  max cost per run, tool timeouts, and capped retries with backoff.
- **Human approvals** — the runtime suspends on `require_approval` and only an
  operator decision resolves the wait. The approval service is the only path
  that resumes a paused action; model output cannot bypass it.
- **Workflows** — graph-based multi-agent orchestration with input, agent,
  approval, and output nodes. Failures skip downstream nodes instead of hanging
  the graph.
- **Evaluation system** — deterministic suites with explicit expectations:
  minimum sources, required citations, required tools, step and latency
  budgets. No LLM judge is used.
- **Tracing, replay, and OTLP export** — append-only per-run event traces,
  replay of completed deterministic runs with event-for-event diffing, and an
  OTLP/JSON export path for a run's events.
- **Metrics and observability** — Prometheus exposition at `/metrics`, an
  in-process event bus used for SSE streaming to the dashboard, and structured
  logging.
- **Model/provider support** — a deterministic mock provider, an Ollama
  provider, and an OpenAI-compatible provider behind a provider registry with
  fallback to the mock provider on failure.
- **Browser automation** — Playwright-based browser tools are registered at
  runtime when Playwright is available, gated by policy like every other tool.
- **MCP integration** — register MCP server commands, perform a tools/list
  handshake, mirror discovered tools into the registry, and route every MCP
  call through the policy engine.
- **Dashboard** — a React dashboard with pages for Dashboard, Agents,
  AgentDetail, Runs, RunDetail, Approvals, Workflows, WorkflowDetail, Tools,
  Policies, Evaluations, Metrics, and Settings.
- **API** — a Fastify control-plane API covering system, agents, runs, tools,
  policies, MCP, workflows, evaluations, approvals, audit, settings, corpus
  fixtures, and Prometheus metrics.
- **CLI** — an `agentos` CLI entry point exposed by `@agentos/cli`, plus dev
  conveniences for demo and doctor flows.

---

## What this is not

This is not a cloud-hosted agent service, a SaaS product, a production
deployment guide, or a benchmark. There are no real users, no paid-provider
usage claimed by this repository, and no performance numbers asserted here. The
repo is a local control plane you run yourself.

---

## Architecture

```
                    ┌───────────────────────────────┐
                    │         Dashboard (React)     │
                    │  /  /agents  /runs ... /settings│
                    └───────────────┬───────────────┘
                                    │ HTTP + SSE
                    ┌───────────────▼───────────────┐
                    │        Fastify server         │
                    │  /api/v1/…   /metrics          │
                    └───────┬───────────┬───────────┘
                            │           │
          ┌─────────────────┘           └─────────────────┐
          ▼                                              ▼
┌─ AppContext ──────────────────────────────────────────┐
│                                                      │
│  ToolRegistry ──► PolicyEngine ──► ApprovalService   │
│       ▲                                  ▲            │
│       │             AgentRuntime          │            │
│  ProviderRegistry ────────────────────────┘            │
│       ▲                                              │
│  Ollama / OpenAI-compatible / DeterministicMock       │
│                                                      │
│  WorkflowEngine        EvaluationRunner               │
│  McpManager            EventBus (SSE)                 │
│  SQLite (AgentDatabase)  Metrics (Prometheus)         │
└──────────────────────────────────────────────────────┘
```

- One Fastify server owns the API and, when `apps/web/dist` exists, serves the
  built dashboard from the same port.
- `AppContext` wires the database, event bus, metrics, tool registry, provider
  registry, approval service, runtime, workflow engine, evaluation runner, and
  MCP manager together at boot.
- The runtime is the only thing that advances a run. Tools, policies, approvals,
  retries, limits, and cost accounting are all evaluated inside the loop.
- Every run event is persisted to SQLite and published on the in-process event
  bus, which feeds both the SSE streams and the dashboard polls.

---

## Repository structure

```
AgentOS/
├── package.json                 # workspace root (MIT, private)
├── .env.example                 # all supported env vars
├── .gitignore
├── tsconfig.base.json
├── apps/
│   ├── server/                  # Fastify control plane
│   └── web/                     # React dashboard (Vite + Tailwind v4)
├── packages/
│   ├── cli/                     # @agentos/cli
│   ├── browser/                 # Playwright browser tools + manager
│   ├── database/                # SQLite + migrations + repos
│   ├── evaluation/              # deterministic eval suites + runner
│   ├── mcp/                     # MCP server registration + tools/list
│   ├── model-providers/         # mock, Ollama, OpenAI-compatible
│   ├── observability/           # logger, metrics, event bus, OTLP export
│   ├── policy-engine/           # deterministic policy decisions
│   ├── runtime/                 # bounded agent loop, approvals, replay
│   ├── shared/                  # schemas, errors, ids, util
│   ├── tool-registry/           # tool definitions, permissions, sandbox
│   └── workflow-engine/         # graph orchestration engine
├── scripts/
│   ├── acceptance-flow.mjs      # end-to-end acceptance against a running server
│   └── smoke-db.ts
└── LICENSE                      # MIT
```

Packages are private npm-style workspaces. `@agentos/cli` currently declares
its bin entry at `./bin/agentos.mjs` and its public export at `./src/index.ts`;
those paths exist as package metadata even when the underlying source files have
not been bootstrapped in this checkout.

---

## Technology stack

- **Runtime:** Node.js >= 20.10
- **Language:** TypeScript, strict mode, ES2022, bundler module resolution
- **Server:** Fastify 5 with `@fastify/cors` and `@fastify/static`
- **Database:** better-sqlite3 with WAL and append-only typed migrations
- **Validation:** Zod for API bodies, agent specs, workflow graphs, eval suites,
  and tool inputs
- **Dashboard:** React 18, React Router v6, TanStack React Query, Tailwind CSS
  v4, Vite 6
- **Observability:** in-process event bus, Prometheus exposition format,
  structured logging, OTLP/JSON trace export
- **Tooling:** vitest for tests, tsx for dev runs, tsc for typecheck, Vite for
  the web build, Playwright as an optional browser runtime
- **License:** MIT

---

## How the runtime works

A run starts when the runtime receives an agent and a task. It records the run
in SQLite, emits `task_received`, and enters a bounded loop.

Each iteration:

1. calls the model provider for the next action — `plan`, `tool_call`, or
   `final` — with the current message trail, the agent's system prompt, the
   agent's allowed tools, the seed, and optional workflow input;
2. records model usage, cost, and locality;
3. if the action is a tool call, checks that the tool is registered, checks the
   agent's permissions, asks the policy engine for a decision, and either allows
   the call, denies it, rate-limits it, or requests human approval;
4. if approval is required, suspends the run until an operator decides, and only
   the approval service can resume it;
5. executes the tool with bounded retries, timeouts, and abort signals;
6. persists the tool result into the message trail and continues.

The loop fails cleanly when any hard limit is hit: max steps, max runtime, max
cost, or an unrecoverable tool failure. Runs can also be cancelled by the
operator. Completed runs store a final result; deterministic runs can be replayed
and diffed.

---

## Agent registry and versioning

Agents are defined by a validated spec: name, description, model reference,
optional system prompt, allowed tools, permissions, embedded policy config,
runtime limits, and an enabled flag.

- `POST /api/v1/agents` creates an agent from a Zod-validated spec.
- `GET /api/v1/agents` lists agents with search and enabled filter.
- `GET /api/v1/agents/:id` returns the agent, its version history, performance
  stats, latest eval summary, capabilities, recent runs, and policies.
- `PATCH /api/v1/agents/:id` updates an agent.
- `POST /api/v1/agents/:id/enable` and `.../disable` toggle state.
- `DELETE /api/v1/agents/:id` refuses if the agent has active runs.
- `GET /api/v1/agents/:id/versions` returns the agent's version history.
- `POST /api/v1/agents/:id/run` starts a run and returns `202`.

Every create, update, enable, disable, and delete is written to the audit log.
Agent versions are stored in `agent_versions` and exposed by the API.

---

## Tool registry

Tools are the unit of capability. Each tool has a name, description, kind,
risk level, required permissions, and an input schema with a sample input
helper.

Builtin tools come from `@agentos/tool-registry` and are registered at boot.
Browser tools from `@agentos/browser` are registered when Playwright is
available. MCP-discovered tools are mirrored into the registry when an MCP
server connects. The server upserts the metadata for every registered tool into
its tools table so the dashboard can show executable status and sample input.

Operators can enable or disable tools and invoke them manually through the API.
Manual invocation is useful for testing a tool outside a run.

---

## Policy and permission system

Policy is deterministic and evaluated on structured facts, not on model output.

The policy engine supports:

- **allowlist mode** — only listed tools, prefix globs such as `corpus.*`, or
  `*` are allowed; everything else is denied;
- **denylist mode** — listed tools are denied; unlisted low/medium-risk tools are
  allowed, while critical tools still require approval;
- **require_approval** — matching tools pause the run for an operator decision;
- **rate limits** — per-tool, per-run caps with deterministic enforcement;
- **stored rules** — global or agent-scoped policy rows that apply on top of an
  agent's embedded config; stored deny rules win even when an agent allows the
  tool.

Permissions are a separate defense layer. A tool can require capabilities such
as `artifacts:write`; if the agent lacks them, the call is denied before policy
evaluation.

Policy decisions are recorded per run with the rule, reason, and an argument
digest, so every block or approval is auditable later.

---

## Run and event tracing

Every run has an append-only event trace. The `EventRecorder` assigns monotonic
sequence numbers, persists each event to SQLite, and publishes it on the event
bus. Events include task receipt, planning, model calls, policy checks, tool
calls and results, approval requests and decisions, retries, and final outcomes.

The API exposes:

- `GET /api/v1/runs` — list with status, agent, and workflow-run filters;
- `GET /api/v1/runs/:id` — run detail with events, decisions, approvals,
  computed metrics, eval results, and replay flag;
- `GET /api/v1/runs/:id/events` and `/decisions`;
- `POST /api/v1/runs/:id/cancel`;
- `POST /api/v1/runs/:id/replay` — re-run a completed deterministic run and diff
  the traces;
- `GET /api/v1/runs/:id/otel` — OTLP/JSON export of the run's events;
- `GET /api/v1/runs/:id/stream` and `/api/v1/events/stream` — SSE channels.

Replay compares the original and replayed traces event-for-event and reports
whether the sequences match and whether the final result is identical. Only
completed deterministic runs can be replayed; live cloud runs are not
bit-reproducible by design.

---

## Approvals

Approval is the human gate for risky actions. The `ApprovalService` persists a
pending approval and returns a promise that only `decide()` resolves. The runtime
suspends on `require_approval` and resumes only after the operator approves or
denies.

API endpoints:

- `GET /api/v1/approvals` — list with status and run filters, plus pending count;
- `POST /api/v1/approvals/:id/approve` and `.../deny`.

The demo seeds a global policy that requires approval for `report.write`, so the
finalizer node in the demo workflow pauses at the publish gate.

---

## Workflows

Workflows are directed graphs of input, agent, approval, and output nodes.
The `WorkflowEngine` starts a workflow run, drives each agent node through the
runtime, handles approval nodes, tracks node runs, and records child runs.

API endpoints:

- `GET /api/v1/workflows` and `POST /api/v1/workflows`;
- `GET /api/v1/workflows/:id`, `PATCH`, `DELETE`;
- `POST /api/v1/workflows/:id/run` — starts a workflow run and returns `202`;
- `GET /api/v1/workflow-runs` and `/api/v1/workflow-runs/:id`;
- `POST /api/v1/workflow-runs/:id/cancel`;
- `GET /api/v1/workflow-runs/:id/stream` — SSE for the workflow run.

Failed nodes skip downstream work rather than hanging the graph. The demo seeds a
`research-report` workflow that runs research, evidence collection, analysis,
evaluation, finalization, and an approval gate before output.

---

## Evaluation system

Evaluation is deterministic. Suites define cases with explicit expectations:
minimum distinct sources, whether citations are required, which tools must be
used, and optional step or latency budgets.

API endpoints:

- `GET /api/v1/evals/suites` and `POST /api/v1/evals/suites`;
- `DELETE /api/v1/evals/suites/:id`;
- `POST /api/v1/evals/suites/:id/run` — starts an evaluation run and returns
  `202`;
- `GET /api/v1/evals/runs` and `/api/v1/evals/runs/:id`.

The demo seeds a `research-agent-eval` suite attached to the Researcher agent,
with cases covering citations, multi-source grounding, topic handling, step and
latency budgets, and narrow queries.

---

## Metrics and observability

The server exposes a Prometheus endpoint at `/metrics`. It tracks active runs,
pending approvals, run totals by status, tool calls and failures, policy
decisions, model tokens, estimated cost, run duration, and provider fallback
events.

The in-process event bus feeds SSE streams for runs and global events, so the
dashboard can stream live run progress without polling every resource.

Structured logging supports a pretty console mode for development. The `/api/v1
/system/doctor` endpoint runs a self-check covering Node version, SQLite, the
deterministic mock provider, the policy engine, the evaluation engine, the
filesystem sandbox, optional Ollama, optional Playwright, optional MCP, metrics,
tracing, configuration, and the dashboard build.

---

## Model and provider support

The provider registry manages model providers and falls back to the deterministic
mock provider when a provider fails. This makes the demo resilient: if Ollama is
not running or an OpenAI-compatible key is not configured, the system degrades
visibly with a `provider_fallback` event instead of silently routing to the mock.

Supported providers in this repo:

- **DeterministicMockProvider** — offline, zero-cost, seed-based, behavior-driven
  mock that sequences plan, tool calls, and final results;
- **OllamaProvider** — local LLM via the Ollama HTTP API;
- **OpenAiCompatibleProvider** — any OpenAI-compatible endpoint, with optional
  price overrides for cost estimation.

Provider locality is tracked per run: mock and local providers cost $0.00; cloud
providers are estimated from configured pricing. Cost accounting is visible in the
summary, timeseries, and metrics.

---

## Deterministic demo mode

By default, AgentOS runs in demo mode. The mock provider, the synthetic corpus,
the seeded agents, policies, workflow, and eval suite make the system fully
functional offline with zero token cost.

Demo corpus documents live in the database and are served as offline HTML pages
under `/fixtures/corpus` and `/fixtures/corpus/:id`. That gives browser-based
corpus tools something to read when there is no internet.

Demo mode does not disable any capability. It simply defaults the model layer to
a deterministic, cost-free provider so the same registry, policies, runtime,
approvals, workflows, evaluations, and observability behave identically without a
cloud dependency.

---

## Browser integration

Browser automation is real but optional. `@agentos/browser` provides a Playwright
manager and browser tools that are registered at runtime when Playwright is
available. Browser tools are still subject to the policy engine, so a browser
action can be denied or require approval the same way any other tool can.

Install Chromium for browser tools with:

```bash
npm run setup:browser
```

The doctor endpoint reports Playwright and Chromium availability separately, and
both are optional. If they are unavailable, browser tools are simply not
registered.

---

## MCP integration

MCP support lets the control plane register external tool servers, perform a
tools/list handshake, mirror discovered tools into its own registry, and route
every MCP call through the policy engine. External tools inherit governance
instead of bypassing it.

MCP servers are registered by command, arguments, and environment. The server
tracks connection status and tool count per server. Failed connections degrade to
explicit errors rather than silent skips.

---

## API overview

All API paths live under `/api/v1`.

**System**

- `GET /api/v1/system/health`
- `GET /api/v1/system/summary`
- `GET /api/v1/system/timeseries`
- `GET /api/v1/system/providers`
- `GET /api/v1/system/doctor`
- `GET /api/v1/audit`
- `GET /api/v1/settings`
- `GET /fixtures/corpus` and `/fixtures/corpus/:id`

**Agents**

- `GET /api/v1/agents`
- `POST /api/v1/agents`
- `GET /api/v1/agents/:id`
- `PATCH /api/v1/agents/:id`
- `DELETE /api/v1/agents/:id`
- `POST /api/v1/agents/:id/enable` and `/denable`
- `GET /api/v1/agents/:id/versions`
- `POST /api/v1/agents/:id/run`
- `GET /api/v1/agents/:id/runs`

**Runs**

- `GET /api/v1/runs`
- `GET /api/v1/runs/:id`
- `GET /api/v1/runs/:id/events`
- `GET /api/v1/runs/:id/decisions`
- `POST /api/v1/runs/:id/cancel`
- `POST /api/v1/runs/:id/replay`
- `GET /api/v1/runs/:id/otel`
- `GET /api/v1/runs/:id/stream`
- `GET /api/v1/events/stream`

**Approvals**

- `GET /api/v1/approvals`
- `POST /api/v1/approvals/:id/approve`
- `POST /api/v1/approvals/:id/deny`

**Tools**

- `GET /api/v1/tools`
- `POST /api/v1/tools/:name/enable` and `/disable`
- `POST /api/v1/tools/:name/invoke`

**Policies**

- `GET /api/v1/policies`
- `POST /api/v1/policies`
- `PATCH /api/v1/policies/:id`
- `DELETE /api/v1/policies/:id`
- `POST /api/v1/policies/evaluate`
- `GET /api/v1/policies/agent/:agentId`

**MCP**

- `GET /api/v1/mcp/servers`
- `POST /api/v1/mcp/servers`
- `POST /api/v1/mcp/servers/:id/reconnect`
- `DELETE /api/v1/mcp/servers/:id`

**Workflows**

- `GET /api/v1/workflows`
- `POST /api/v1/workflows`
- `GET /api/v1/workflows/:id`
- `PATCH /api/v1/workflows/:id`
- `DELETE /api/v1/workflows/:id`
- `POST /api/v1/workflows/:id/run`
- `GET /api/v1/workflow-runs`
- `GET /api/v1/workflow-runs/:id`
- `POST /api/v1/workflow-runs/:id/cancel`
- `GET /api/v1/workflow-runs/:id/stream`

**Evaluations**

- `GET /api/v1/evals/suites`
- `POST /api/v1/evals/suites`
- `DELETE /api/v1/evals/suites/:id`
- `POST /api/v1/evals/suites/:id/run`
- `GET /api/v1/evals/runs`
- `GET /api/v1/evals/runs/:id`

**Metrics and streaming**

- `GET /metrics`
- `GET /api/v1/runs/:id/stream`
- `GET /api/v1/events/stream`

---

## Dashboard routes

The React dashboard routes mirror the main resources:

- `/` — Dashboard
- `/agents` — Agents list
- `/agents/:id` — Agent detail
- `/runs` — Runs list
- `/runs/:id` — Run detail
- `/approvals` — Approvals
- `/workflows` — Workflows list
- `/workflows/:id` — Workflow detail
- `/tools` — Tools
- `/policies` — Policies
- `/evaluations` — Evaluations
- `/metrics` — Metrics
- `/settings` — Settings

In dev, the Vite server runs on port 5173 and proxies `/api`, `/metrics`, and
`/fixtures` to the server. When the web build exists, the server serves the
built dashboard from the same port as the API.

---

## CLI commands

The workspace exposes these conveniences from the root:

```bash
npm run dev              # server + web concurrently
npm run dev:server       # server only
npm run dev:web          # web only
npm start               # server
npm run build           # web build
npm run typecheck       # TypeScript check across the repo
npm test                # vitest run
npm run test:watch      # vitest watch
npm run test:e2e        # vitest run tests/e2e
npm run lint
npm run cli             # node packages/cli/bin/agentos.mjs
npm run demo            # node packages/cli/bin/agentos.mjs demo
npm run doctor          # node packages/cli/bin/agentos.mjs doctor
npm run setup:browser   # playwright install chromium
```

The CLI entry point is `node packages/cli/bin/agentos.mjs`. The package declares
a `demo` subcommand and a `doctor` subcommand from the root `package.json`.

---

## Local setup

### Prerequisites

- Node.js >= 20.10
- npm
- Git
- On Windows, use Git Bash, PowerShell, or WSL for the shell commands below.

### 1. Clone and install

```bash
git clone https://github.com/Revanth2716/AgentOS.git
cd AgentOS
npm install
```

### 2. Configure environment

Copy the example and edit what you need:

```bash
cp .env.example .env
```

All variables are optional. The app runs fully offline with demo defaults.

Key variables:

- `AGENTOS_PORT` — server port, default `8787`
- `AGENTOS_HOST` — bind address, default `127.0.0.1`
- `AGENTOS_DATA_DIR` — data directory, default `.agentos`
- `AGENTOS_DEMO_MODE` — default `true`
- `AGENTOS_OLLAMA_URL` — default `http://127.0.0.1:11434`
- `AGENTOS_OLLAMA_MODEL` — default `llama3.2`
- `AGENTOS_OPENAI_BASE_URL` — default `https://api.openai.com/v1`
- `AGENTOS_OPENAI_API_KEY` — optional
- `AGENTOS_OPENAI_MODEL` — default `gpt-4o-mini`
- `AGENTOS_PRICE_OVERRIDES` — optional JSON price overrides
- `AGENTOS_FETCH_ALLOW_HOSTS` — optional comma-separated hosts for `http.fetch`
- `AGENTOS_LOG_PRETTY` — pretty console logs, default `false`

### 3. Run locally

```bash
npm run dev
```

Then open the dashboard at the printed URL, usually:

- Dashboard: `http://127.0.0.1:8787`
- API: `http://127.0.0.1:8787/api/v1`
- Metrics: `http://127.0.0.1:8777/metrics`

In dev, the dashboard also runs under Vite at `http://127.0.0.1:5173`, with API
and metrics proxied to the server.

### 4. Run the doctor

```bash
npm run doctor
```

Or hit `GET /api/v1/system/doctor` against a running server.

---

## Database

AgentOS uses a single SQLite database per instance, created and migrated
automatically on first boot. The default location is
`.agentos/agentos.db`, or whatever `AGENTOS_DATA_DIR` specifies.

Migrations are typed and append-only, applied once each in a transaction. The
schema includes:

- agents and agent versions
- tools, including MCP-linked tools
- policies
- runs with snapshots, limits, costs, and final results
- run events
- policy decisions
- approvals
- costs
- MCP servers
- audit log
- settings
- workflows, workflow runs, and workflow node runs
- eval suites, eval runs, and eval case results
- demo corpus
- run state and counters

The database is local and file-based. It is not a multi-process cloud database.

---

## Testing

```bash
npm test
```

The repo uses vitest. Test suites exist for runtime behavior, the model
providers, the policy engine, the tool registry, the browser package, the MCP
package, and observability. Runtime tests exercise bounded execution, approvals,
retries, limits, cancellation, replay, and provider fallback using an in-memory
database and a test harness.

---

## Build

```bash
npm run build
```

This builds the web dashboard with Vite into `apps/web/dist`. When the dist
exists, the server serves the built dashboard from the same port as the API.

TypeScript typechecking is separate:

```bash
npm run typecheck
```

---

## Running the demo

The easiest way to see the system work is to start it and let it seed itself:

```bash
npm run dev
```

On first boot, the server seeds a demo corpus of 10 synthetic documents, 5
agents, 2 global policies, 1 workflow, and 1 eval suite. The startup log prints
the dashboard, API, and metrics URLs plus whether demo mode is on.

From there:

- Run the **Researcher** agent from the dashboard or `POST /api/v1/agents/:id/run`.
- Open a run detail page to watch the trace, decisions, and approvals.
- Replay a completed deterministic run and compare the traces.
- Run the **research-report** workflow; it pauses at the final approval gate.
- Run the **research-agent-eval** suite and watch deterministic case results.

The script `scripts/acceptance-flow.mjs` exercises this flow end to end against a
running server.

---

## Example workflow: research report

The seeded `research-report` workflow runs:

1. **input** — receive the task,
2. **research** — the Researcher agent searches the corpus,
3. **evidence** — the Evidence Collector reads additional sources,
4. **analyze** — the Analyst derives themes and coverage,
5. **evaluate** — the Evaluator checks citations and source counts,
6. **finalize** — the Finalizer composes the markdown report,
7. **approval gate** — `report.write` requires operator approval,
8. **output** — the result.

The approval gate is enforced by a global policy, not by the model. If the
operator denies publication, the tool never runs and the run still terminates
cleanly. If the operator approves, the report is written to the artifacts
directory.

This is the pattern the system is designed for: multiple specialized agents,
deterministic policies, human oversight on side effects, and a trace you can
inspect or replay.

---

## Zero-cost, local-first positioning

AgentOS is built so that the vast majority of iteration can happen without a
cloud model and without a bill. In demo mode, the deterministic mock provider
runs offline, the corpus lives in the database, and the total cost reported by
the system is $0.00.

That does not mean the system is limited to mocks. The same runtime and policy
layer work with Ollama or any OpenAI-compatible provider. Cloud providers are
metered and estimated, and fallback to the mock is explicit when a provider
fails. The intent is to keep the control plane local, with cloud models as
an opt-in configuration choice rather than a requirement.

This is a local project you run on your own machine. It is not a hosted service
and does not claim production cloud deployment.

---

## Security and safety design

Safety in AgentOS is enforced by the platform, not by the model.

- **Deterministic policy** — decisions come from structured inputs only: agent
  identity, tool name, argument digest, policy config, stored rules, and call
  counts. Prompt injection cannot change a policy verdict.
- **Permissions** — tools declare required permissions; agents without them are
  denied before policy evaluation.
- **Allowlist default** — the default policy mode is allowlist, so unlisted tools
  are denied unless an operator widens the policy.
- **Human approvals** — risky actions can require approval, and only the approval
  service can resume a paused action. Model output cannot bypass the gate.
- **Bounded execution** — max steps, max runtime, max cost, tool timeouts, and
  capped retries guarantee termination.
- **Audit log** — every agent, tool, policy, run, approval, and MCP operation is
  recorded with an actor and target.
- **Tool risk levels** — every tool has a risk level that feeds policy decisions.
- **Network guard** — `http.fetch` is governed by `AGENTOS_FETCH_ALLOW_HOSTS` so
  the tool cannot reach arbitrary hosts unless configured.
- **Workspace sandbox** — filesystem tools operate in a per-run workspace and a
  shared artifacts directory, not arbitrary paths.

---

## Current project status

AgentOS is a working local control plane with a server, dashboard, CLI entry
point, tests, and an acceptance flow. It runs end to end in demo mode on a
laptop. The repo is at version `0.1.0` and is private in this checkout.

Some parts, such as the CLI entrypoint files referenced by `@agentos/cli`, are
declared in package metadata and still need their implementation files to be
present for the CLI to run directly. The server, dashboard, packages, API, and
tests are the implemented core.

---

## Planned work

These are planned and not implemented here:

- A fully bootstrapped CLI entrypoint at `packages/cli/bin/agentos.mjs` and its
  source entry at `packages/cli/src/index.ts`, so `npm run cli`, `npm run demo`,
  and `npm run doctor` run as real commands.
- End-to-end browser test suites under `tests/e2e`.
- Any hosted, multi-user, or production-cloud deployment story beyond the local
  server and dashboard.
- Benchmarks, real-user reporting, or paid-provider usage claims.

---

## License

AgentOS is MIT-licensed. See the root `package.json` and the `LICENSE` file in
the repository.

---

## Repository

- GitHub: `https://github.com/Revanth2716/AgentOS`
- Readme source: `README.md` in the repository root
