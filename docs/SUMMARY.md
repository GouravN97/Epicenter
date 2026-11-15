# Project summary

Snapshot of where Epicenter stands on **15 November 2026**, for the two of us. The README is the
judge-facing description (features, setup, data flow, attribution); this file is the team status: what is
built, where it lives, what was verified and what is left before submission.

Person A is on leave; Person B finished A10–A12 and the remaining fixes below. Every change to A's areas
(`shared/`, `server/`, `simulator/`, `tools/stress`) is listed here so A can catch up.

## In one paragraph

Epicenter is a MERN + Socket.IO observability dashboard for a simulated 48-node, 9-service fleet
("ShopStream"). Agents batch telemetry to an ingest API, the server deduplicates it, folds it into 1-second
buckets, bulk-writes to MongoDB and pushes only what changed to the browsers subscribed to each room. On top
of that it detects anomalies, groups related alerts into one incident with a named **epicenter** service
and blast radius, explains it (rule-based analysis, similar past incidents, a postmortem draft), lets an
admin inject faults from a **Chaos Lab**, and replays any incident like a flight recording. Track:
High-Throughput Streams & Telemetry.

## Live

| What | Where |
|---|---|
| Web app (Vercel) | <https://epicenter-one.vercel.app> |
| API (Render, free instance, embedded simulator) | <https://epicenter-api-lsi0.onrender.com> |
| Database | MongoDB Atlas free cluster `epicenter` (user `epicenter`) |

Render's free instance sleeps when idle and has a fraction of a CPU: open the API a minute before a demo.
Its event-loop lag sits near the 150 ms shedding threshold, so the Pipeline page shows brief shedding blips
(about 3% of batches get a 429 and are re-sent; nothing is lost).

## Repository layout

| Path | Owner | Contents |
|---|---|---|
| `shared/` | A | The contract: topology, zod schemas and REST types, Socket.IO event and tuple layouts, constants, incident insights rules |
| `server/` | A | Express 5 + Socket.IO + Mongoose: auth, ingest, dedup, aggregator, writer, history and replay API, broadcaster, detector, alerts, correlator, incidents and insights, chaos, presence, embedded simulator |
| `simulator/` | A | Load model of the fleet, per-region ingest agents, chaos scenarios, malformed-flood generator |
| `tools/stress/` | A | Load generator and `docs/BENCHMARKS.md` writer |
| `client/` | B | React 19 + Vite app: data layer (`src/data`), pages, components, and a full mock backend (`src/mocks`) |
| `docs/` | B | `ARCHITECTURE.md`, `BENCHMARKS.md`, `DEMO.md`, `implementation_plan.md`, this file |
| `render.yaml`, `client/vercel.json` | — | Hosting configuration |

## Task status

| Task | What | State |
|---|---|---|
| A1–A10 | Contract, models, auth, seed, simulator, ingest, dedup, aggregator, broadcaster, writer and history, detector and alerts, chaos, correlator and incidents, backpressure | on `main` |
| A11 | Stress tool and `docs/BENCHMARKS.md` | done by B |
| A12 | Hosting: embedded simulator, several CORS origins, `render.yaml`, Render + Atlas | done by B, live |
| B1–B12 | Client, every page, replay, Chaos Lab, Pipeline X-ray, polish, README, architecture | on `main` |
| B11 | Vercel deployment | live (deployed with the Vercel CLI; Git auto-deploy not connected yet) |
| Extra | Incident insights panel, desktop notifications, guided tour, Glass display mode | on `main` |
| B13 | Demo video | **not recorded** |

## What has been verified

- **Real server, local MongoDB:** login, live heatmap and charts, history/live merge across a dropped
  connection, viewer team scoping, alerts, incidents, replay of an open incident, incident insights against
  real incidents, Chaos Lab *Slow database* with a correct epicenter on the scorecard.
- **Production-like run** (`NODE_ENV=production`, embedded simulator, two allowed origins): 96 events/s, CORS
  accepts the listed origins and refuses others, clean shutdown.
- **Hosted:** health endpoint, CORS for the Vercel origin, Socket.IO long-polling no longer crashes the
  server, sign-in from the Vercel site.
- **Benchmarks:** four profiles in `docs/BENCHMARKS.md`, each on a fresh local server and database, plus
  probes that found the writer limit (fixed) and the memory ceiling at 20,000 nodes.
- **Mock mode:** every feature, desktop and phone width, keyboard.

**Not yet verified on the hosted site:** the payments viewer's scoping and desktop notifications over HTTPS
(both work locally).

## Fixed during the final stretch (for Person A)

1. **Socket.IO long-polling crashed the server** (`server/src/index.ts`). Express also answered
   `/socket.io/` requests, so the second reply threw `ERR_HTTP_HEADERS_SENT`. Browsers use WebSocket, so it
   never showed locally; any bot hitting the hosted API would have taken it down.
2. **`EMBEDDED_SIM`** was read but never acted on. The server now starts the simulator in-process.
3. **`CLIENT_ORIGIN`** takes a comma-separated list (Vercel URL plus localhost).
4. **Writer throughput** (`server/src/pipeline/writer.ts`). After a flush it waited for the next point before
   flushing again, which capped writes at about 4,000 points/s (≈ 4,000 nodes) although MongoDB takes far
   more. It now drains a backlog flush after flush. Before/after numbers are in `docs/BENCHMARKS.md`.
5. **Per-run chaos Stop** (`POST /chaos/stop`). It stopped every run whatever `runId` said. It now stops only
   the given run (all runs when there is none) and answers `{ active, stopped }`, as the client and the mock
   expected.
6. **Service latency at the history/live seam.** `/metrics/service` returned the maximum node latency while
   live `svc:pt` sends the nearest-rank p95. History now uses the same `percentile()` as the live path.
7. **Stress tool** (`tools/stress`, task A11) written; results in `docs/BENCHMARKS.md`. The simulator now
   exports its `Agent` class so the stress tool sends exactly like the simulator.

## Known issues

1. Vercel is not connected to the GitHub repository, so pushes to `main` redeploy only the API. Connect it in
   Vercel → project `epicenter` → Settings → Git, or redeploy with `npx vercel deploy --prod` from the repo
   root.
2. The three seeded demo passwords are short; set longer ones in `.env` and re-run the seed against Atlas
   before sharing the hosted URL.
3. Keep `meta:pt.ts` as the emit time; the client and the stress tool measure delivery delay from it.
4. One server process tops out around 10,000 nodes: the aggregator keeps 60 s of buckets per node for late
   events, and 20,000 nodes exceed Node's default 2 GB heap (the server crashes rather than degrading).

## Left to do before submission

| What | Notes |
|---|---|
| Demo video (3–5 min) | Follow `docs/DEMO.md`; record against the hosted site or the local real stack; upload unlisted and link it in the README |
| Optional: RCAEval real-failure replay | Only if time is left after the video |

## Where to find things

| Need | Look at |
|---|---|
| Run it, features, data flow, deploy, attribution | `README.md` |
| Diagrams, data model, rooms and payloads, replay, performance, security | `docs/ARCHITECTURE.md` |
| Load-test results | `docs/BENCHMARKS.md` |
| Demo recording plan | `docs/DEMO.md` |
| Original plan and task definitions | `docs/implementation_plan.md` (§12 for tasks) |
| Team conventions | `CLAUDE.md` |
| Drop the connection for a demo or test | browser console: `epicenter.drop(15000)` |
