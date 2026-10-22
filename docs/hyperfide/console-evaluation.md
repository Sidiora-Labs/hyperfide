# Console evaluation: OpenHands fork vs. expanded VS Code extension

Task hyperfide-v21/1.10 (req 5.4, decision D6). Review date 2026-10-22. This document records the evaluation. The choice itself is a human decision. It is raised as a decision Ask, and task 6.10 records the answer in a `## Decision` section. No fork has been started and no console code has been written.

## What is being chosen

Four humans watch hundreds of agents through four panels, each over a Hyperfide read model (req 5.1):

- **Needs**: open Asks, pending human intents, admission escalations.
- **Issues**: leader queue, external intake, escalated repairs, findings.
- **Sandboxes**: sandboxes joined with slots, runners, identity status and attempts.
- **Leaders**: leader sessions, followed and steered.

There are two candidate bases:

- **A. Fork OpenHands.** Bring the four panels up in a fork under `console/`.
- **B. Expand the VS Code extension.** Grow `editors/vscode` into the console.

Req 5.4 already obliges the editor to get pushed cards, a global Ask registry with badge and notification, the Needs, Issues, Sandboxes and Leaders views, reconnect snapshots, unique agent names and a current VSIX. **Option B's work is therefore required in every case. Option A is a second console surface added on top of it, not an alternative to it.** This frames every cost line below.

## OpenHands as of 2026-10-22

Sources: the GitHub API and the repository files of the `OpenHands` organisation, read on 2026-10-22. They are listed at the end. Items marked *(unconfirmed)* come from secondary pages or are inferences.

| Aspect | Finding |
|---|---|
| What the main repo is now | `OpenHands/OpenHands` is no longer the Python app with a React frontend. It is **Agent Canvas**, published as `@openhands/agent-canvas` v1.30.1 (released 2026-10-22). It is a TypeScript-only "self-hosted developer control center for coding agents and automations". The former Python application lives in `OpenHands/legacy` (licence NOASSERTION). |
| Licence | Main repo: **MIT** (GitHub SPDX `MIT`; LICENSE "Copyright 2025 OpenHands contributors"). The repo has no `enterprise/` directory any more. `software-agent-sdk` (Agent Server) and `automation` are **MIT**. Enterprise features moved to the separate `OpenHands/enterprise` repo under the **PolyForm Free Trial License**, which is source-available, not open source, and limited to 30 days of use per calendar year without a commercial licence. `OpenHands-Cloud` and `sandbox-server` are NOASSERTION. |
| Frontend | React with React Router (framework mode), Vite, Tailwind, HeroUI, Zustand stores, TanStack React Query, i18next, Monaco, xterm.js and framer-motion, plus `posthog-js` telemetry. Electron packaging is in `electron/` and a Helm chart is in `helm/agent-canvas`. The repo has about 3,100 files, about 690 of them under `src/components`. Node >= 24. |
| Backend | The **OpenHands Agent Server** (`software-agent-sdk`, Python/FastAPI). It exposes REST and WebSocket endpoints for conversations, events, bash, files, desktop and VS Code, and OpenAI-compatible `/v1/chat/completions` and `/v1/responses`. Canvas service adapters in `src/api/` call it directly. One Canvas can register several Agent Servers and switch between them. An optional Automation Server (Python, MIT) handles scheduled and event-driven runs, and an ingress puts the frontend, Agent Server and automation behind one origin. |
| Runtime / sandboxes | There are three modes: no sandbox (host filesystem), one Docker sandbox, or `OH_CONVERSATION_RUNTIME=docker`, which gives each conversation its own container running its own Agent Server. `DockerWorkspace` and `RemoteAPIWorkspace` are in the SDK. |
| Event stream | Each conversation has typed Pydantic events (action/observation), served over REST plus WebSocket. The stream is **per conversation**. There is no cross-conversation inbox or "needs" queue. |
| Multi-conversation | Yes. Many conversations per Agent Server, with an optional container per conversation. |
| ACP | Yes. The Agent Server spawns ACP agents (Claude Code, Codex, Gemini CLI, Pi, OpenCode) as stdio subprocesses and relays turns to them, so the ACP client is server-side. How permission requests are surfaced is not documented *(unconfirmed)*. |
| MCP | The SDK tool system has MCP integration. Configuring it per conversation from Canvas is not documented *(unconfirmed)*. |
| Auth / multi-user | OSS: **one shared key** (`LOCAL_BACKEND_API_KEY`, header `X-Session-API-Key`). There are no user accounts, roles or SSO, and the self-hosting guide sizes it for "a single user". Open issue #16492: the bundled OpenVSCode shares the Canvas origin, so its scripts can read the `localStorage` that holds every backend's key. Multi-user RBAC and SAML exist only in `OpenHands/enterprise` (PolyForm, paid beyond 30 days a year). |
| Extension point | "Canvas extensions" are trusted browser ES-module bundles that add a left-rail page under `/extensions/...`. The Agent Server endpoints for them (`/api/canvas-extensions`) are **still pending upstream**, so today a new page means patching the fork. |
| Pace | Five releases in four days (v1.28.0 on 2026-10-19 to v1.30.1 on 2026-10-22). Any fork carries a heavy rebase burden. |

## Hyperfide facts that decide fit

- The control service accepts only `POST /v1/invoke` and `POST /v1/enroll` over TLS 1.3. Every invocation carries an Ed25519 proof from an enrolled credential and is authorised by role (`services/hyperfide/src/transport/http.ts:25-29`; the client is `createServiceClient` in the same file). A browser cannot safely hold that private key. A web console therefore needs a backend-for-frontend that holds a credential, and that adds a new principal, role and policy grant.
- The `cg` client already holds a credential and is where req 5.2 puts the `console` and `needs` verbs. The extension runs on each human's machine as that human, with their own identity, and reaches Hyperfide through `cg`.
- The extension already has a tested ACP client (`editors/vscode/acp.js`, 19_acp.sh PASS), a single event fold point (`serve.js applyEvent`), a refresh chain (`extension.js runRefresh`), a Fleet tree that serves as the template for Sandboxes, and attach/steer webview code for Leaders. The panel placements are worked out in the editors inventory, section 8.

## Criteria

| Criterion | A. OpenHands fork | B. Expanded VS Code extension |
|---|---|---|
| **Licence** | MIT for Canvas, the Agent Server and Automation, so a fork is permitted. Multi-user, RBAC and SAML are PolyForm Free Trial only, so a team console cannot lean on them without buying a licence. Canvas also ships `posthog-js` telemetry, which conflicts with the Local First principle and would have to be stripped and kept stripped. | The code is ours. The VS Code extension API adds no licence constraint. |
| **Frontend reuse for the four panels** | Low to moderate. The UI is built around conversations on an Agent Server: adapters in `src/api/`, conversation stores and an event renderer. Needs, Issues and Sandboxes are tables and queues over Hyperfide read models, so they reuse the design system (HeroUI, Tailwind) but none of the data layer. Leaders reuses the most, since conversation rendering suits a leader transcript, but only if leader sessions are presented as Agent Server conversations, which they are not. The extension mechanism needs a pending upstream backend. | High. Needs, Issues and Sandboxes are native TreeViews: badges, inline actions, `when` clauses, QuickPick answers and `showInputBox({password:true})` so secrets never enter a webview. Issues also feeds the Problems view. Leaders reuses `agentpanel.html` in attach mode. All of it is required by req 5.4 anyway. |
| **Backend overlap with Hyperfide** | Large and conflicting. The Agent Server, per-conversation Docker runtime and Automation Server duplicate Hyperfide's runner, provisioner (Railway/Blaxel sandboxes), dispatch and scheduler. A fork would discard the OpenHands backend and keep only the frontend, which removes most of its value, or it would run two orchestrators with two sandbox models and two sources of truth. | None. The extension adds no backend. It reads the req 5.1 read models through `cg` and `cg serve` events. |
| **ACP and MCP fit** | ACP is server-side in the Agent Server, so Hyperfide's agents would have to be launched by OpenHands to appear. Hyperfide launches its own native sessions in sandboxes. MCP config from Canvas is undocumented. | ACP client in the editor (v1, tested). `hyperfide mcp` is injected as a stdio MCP server today. The known gaps (terminal bridge, authenticate, MCP env) are listed in the inventory as S/M items. |
| **Auth and multi-user** | OSS has one shared key, no users, and the localStorage key exposure (#16492). Fitting it to Hyperfide's per-credential Ed25519 model needs a new backend-for-frontend, a console principal and a policy grant, and attributing an answer to a human needs per-user login built by us or bought (Enterprise). | Each human uses their own enrolled credential through `cg`, so Ask answers are attributed to that human by the existing identity model. No new principal and no shared secret. |
| **Operating cost, team of four** | One more always-on host (Canvas plus a BFF; the guide sizes 2 vCPU / 4 GB *for one user*), TLS, the BFF credential's rotation and attestation, telemetry stripping, and the dominant cost of rebasing a fork that releases several times a week. Rough estimate: a small VM at tens of dollars a month plus a recurring share of an engineer for upkeep *(estimate, not measured)*. | No hosting. It runs on each laptop. The cost is the extension upkeep already owed under req 5.4, plus repackaging the VSIX per wave. |
| **Time to a first usable panel** | Slower. The steps are: fork and build, strip telemetry, write the BFF with a signed Hyperfide client, add the console principal and policy, deploy with TLS, then patch a Needs route into the fork. All of this sits on top of the read model (3.x/5.x) that both options wait for. Estimate: weeks after the read model lands *(estimate)*. | Faster. Fix B1 (S), then build the Needs tree with badge and notification (M), merging ACP permission asks and fleet approvals, which exist today, with durable Asks once 3.4 and 5.x land. The local half can ship before the durable Ask exists. Estimate: days *(estimate)*. |

## Risks of the recommendation

- VS Code is the only console surface. A human without VS Code (on a phone, or in a browser) has no console. The mitigation is below.
- Webview-heavy panels inherit VS Code's layout limits. Sandboxes for 100 sandboxes needs paging and filtering in the tree, as `fleet.js` already does for workers.
- The extension's known defects (B1 pushed cards never installed, B5 per-window agent names, B6 refresh cost, stale VSIX) must be fixed first. Req 5.4 requires that anyway.

## Recommendation

**Option B: expand the VS Code extension as the console, and do not fork OpenHands now.**

Reasons, in order:

1. The extension's four panels are required by req 5.4 whatever happens. A fork adds a second surface with its own hosting, auth and upkeep, and gives back no panel the extension will lack.
2. OpenHands' value lies in its backend (Agent Server, per-conversation Docker runtime, automation), and that backend is exactly what Hyperfide already owns. Keeping only the frontend leaves a conversation-centred UI whose data layer does not fit queues of Asks, findings and sandboxes.
3. Auth does not fit. Hyperfide authenticates per request with an Ed25519 credential bound to a role, while OSS OpenHands offers one shared key, and the multi-user features are behind the PolyForm Free Trial licence. A fork needs a new BFF principal and per-user login before an answer to an Ask can be attributed to a human (D9).
4. Upstream ships several releases a week, so a fork is a permanent rebase cost for a team of four.
5. Time to first panel is days on B against weeks on A, and B's first panel can ship before the durable Ask lands.

Revisit A, or a thin unforked Canvas extension instead of a fork, if any of these becomes true:

- a human must answer Asks from outside VS Code;
- upstream ships the `/api/canvas-extensions` backend with a documented host API;
- OpenHands OSS gains per-user auth.

In that case, build a read-only web view over the same read models first. Separately, any individual may run unmodified Agent Canvas as an ACP chat client, which needs no fork and no decision.

## Sources

- GitHub API, `repos/OpenHands/OpenHands` (licence, releases, tree) and `orgs/OpenHands/repos` (sibling repo licences), read 2026-10-22.
- https://github.com/OpenHands/OpenHands (README, LICENSE, package.json)
- https://raw.githubusercontent.com/OpenHands/OpenHands/main/docs/architecture.md
- https://raw.githubusercontent.com/OpenHands/OpenHands/main/docs/SELF_HOSTING.md
- https://raw.githubusercontent.com/OpenHands/OpenHands/main/docs/ACP_AGENTS.md
- https://raw.githubusercontent.com/OpenHands/OpenHands/main/docs/CANVAS_EXTENSIONS_TESTING.md
- https://github.com/OpenHands/enterprise (PolyForm Free Trial License)
- https://docs.openhands.dev/sdk/arch/overview.md
- Internal: services/hyperfide/src/transport/http.ts, and the 2026-10-22 inventory reports editors.md (sections 2, 3, 4, 8, 9) and INVENTORY.md.
