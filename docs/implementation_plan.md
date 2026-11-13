# Epicenter — Implementation Plan

**MERNIFY Hackathon · Track: High-Throughput Streams & Telemetry · Domain: Server & Network Observability**
**Team: 2 people · 48 hours**

> How to use this file: put it in the repo root. Each person opens Claude Code in the repo and says
> "Read implementation_plan.md. I am Person A (or B). Do task A1." Tasks are self-contained, have file
> paths, contracts and acceptance checks. Sections 4–7 are the shared contract; do not change them
> without telling your teammate.

---

## 1. The idea

### 1.1 One-liner

**Epicenter is a real-time observability platform that doesn't just show you that servers are on fire — it
finds where the fire started, shows how far it spread, and lets you replay the whole incident like a
flight recording.**

### 1.2 Why this and not "a Grafana clone"

Server observability is the most obvious domain in the problem statement, so most teams picking it will
ship the same thing: a grid of CPU/memory line charts. That scores well on Functionality and badly on
Originality (20% of the marks). Epicenter keeps the safe domain and adds four things a judge will remember:

| # | Signature feature | What the judge sees | Criteria it hits |
|---|---|---|---|
| 1 | **Epicenter tracing** | A live service-dependency map. When a database slows down, alerts cascade to every service that depends on it. Epicenter groups them into one incident, marks the root service, and animates the blast radius outward from it. | Originality, anomaly-detection bonus |
| 2 | **Chaos Lab** | An admin panel with buttons: "memory leak", "kill node", "slow database", "10× traffic", "duplicate storm", "malformed flood". The judge presses one and watches the system detect it. A scorecard shows time-to-detect and whether the root cause was identified correctly. | Functionality, demo impact, proves validation / dedup / rate limiting live |
| 3 | **Incident Replay** | Every incident is a recording. A scrubber replays the heatmap, topology and charts at 1×–16×, then "Go Live" rejoins the live stream with no gap or duplicate. | Historical + live integration (a core requirement), UX |
| 4 | **Pipeline X-ray** | The platform monitors itself: events/sec, duplicates dropped, late events corrected, write-batch size, bytes/sec per socket room, end-to-end latency p95, event-loop lag. | Performance-measurement bonus, Technical Implementation |

Supporting features: a canvas heatmap of the whole fleet, per-node drill-down with a "same time one hour
ago" baseline overlay, team-scoped access (a payments-team viewer never receives another team's data), and
an incident war room with presence and shared annotations.

### 1.3 The simulated world

A fictional e-commerce company, "ShopStream", runs 48 servers across 3 regions and 9 services. Load flows
through a real dependency model, so cascades emerge from the simulation rather than being scripted — this
is what makes the root-cause tracing an honest feature.

```
                edge-gateway
               /     |       \
            auth  catalog-api  orders-api
            /  \    /   \      /   |    \
       cache   db  cache db   db  queue  payments
                                    |
                                  worker ──> db
```

Teams (used for access control): `platform` (edge-gateway, auth) · `commerce` (catalog-api, orders-api) ·
`payments` (payments) · `data` (db, cache, queue, worker).

### 1.4 Requirement coverage

| Requirement from the problem statement                      | Where it is met                                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Ingest continuous streams from multiple sources             | 48+ simulated agents → `POST /api/v1/ingest` in batches (§6.1)                                        |
| Process events, maintain system state                       | In-memory state store + 1-second aggregator (§8.2)                                                    |
| Store telemetry for history                                 | `metrics_1s`, `metrics_1m` collections (§5)                                                           |
| Broadcast via Socket.IO, integral to delivery               | All live data flows through `/dash` namespace rooms (§7)                                              |
| Rooms / namespaces                                          | 2 namespaces, 7 room families (§7.1)                                                                  |
| Batching / throttling / aggregation                         | Agent batches, server 1s aggregation, batched `bulkWrite`, 1 Hz delta broadcast (§8)                  |
| History + live with no duplicates                           | Idempotent upsert keyed on `(nodeId, ts)` in the DB, on the wire and in the client store (§8.5, §9.2) |
| Source id, event id, timestamp; duplicates and out-of-order | `nodeId` + `bootId` + `seq` + `ts`; sliding-window dedup; late-event correction with `rev` (§4, §8.1) |
| Client stays responsive                                     | Data outside React state, ring buffers, rAF-batched canvas draws, visible-only subscriptions (§9)     |
| Validation + rate limiting                                  | zod schemas, per-agent token bucket, body limits (§8.1)                                               |
| Auth + access control                                       | JWT, 3 roles, team-scoped rooms (§6.3, §7.2)                                                          |
| Charts / maps / heatmaps                                    | uPlot charts, canvas fleet heatmap, topology graph (§9.3)                                             |
| **Bonus:** optimized payloads, selective broadcast          | Positional arrays, changed-nodes-only deltas, msgpack parser, per-team rooms (§7.3)                   |
| **Bonus:** independent subscriptions                        | Per-socket room sets, ref-counted on the client (§9.2)                                                |
| **Bonus:** historical analysis                              | Baseline overlay, incident report, Mongo aggregation for service history (§6.2)                       |
| **Bonus:** anomaly detection + alerts                       | EWMA z-score, thresholds, heartbeat, predictive memory trend (§8.6)                                   |
| **Bonus:** backpressure                                     | Event-loop-lag shedding with `429 Retry-After`, bounded write buffer, volatile emits (§8.4)           |
| **Bonus:** stress-test numbers                              | `tools/stress` writes `docs/BENCHMARKS.md` (§10)                                                      |
| **Bonus:** hosting                                          | Render (API + embedded simulator), Vercel (client), MongoDB Atlas (§11)                               |
| **Bonus:** architecture document                            | `docs/ARCHITECTURE.md` (§12.2)                                                                        |

---

## 2. Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript everywhere | Shared types are the contract between the two of you |
| Repo | npm workspaces: `shared`, `server`, `simulator`, `client`, `tools` | One install, shared schemas |
| Backend | Node.js 20+, Express, Socket.IO, Mongoose (raw `collection.bulkWrite` on the hot path) | Mandatory stack |
| Validation | zod (schemas live in `shared`) | Same schema validates on agent and server |
| Auth | jsonwebtoken, bcryptjs, helmet, cors, express-rate-limit (login route only) | |
| Frontend | React + Vite, React Router, Tailwind CSS, zustand (UI state only) | |
| Charts | uPlot | Canvas-based, built for streaming time series |
| Topology | @xyflow/react | Custom nodes and animated edges without writing a layout engine |
| Lists | @tanstack/react-virtual | Windowing for alert and node tables |
| Wire format | socket.io-msgpack-parser on both ends | One-line payload reduction |
| Tests | vitest for pure logic only (dedup, aggregator, detector, correlator, series buffer) | These are the parts that silently break |

Do not pin versions from memory; install latest stable and commit the lockfile. Every library goes in the
README attribution table (a submission requirement).

---

## 3. Repository layout

```
epicenter/
├─ implementation_plan.md
├─ CLAUDE.md                     # short: conventions + "read implementation_plan.md §4–7 before coding"
├─ README.md
├─ package.json                  # workspaces + root scripts: dev, dev:server, dev:client, sim, stress, seed, test
├─ .env.example
├─ docs/
│  ├─ ARCHITECTURE.md            # bonus deliverable
│  └─ BENCHMARKS.md              # generated by tools/stress
├─ shared/src/
│  ├─ topology.ts                # services, teams, dependsOn, regions (single source of truth)
│  ├─ schemas.ts                 # zod: TelemetryEvent, IngestBatch, auth, REST params
│  ├─ wire.ts                    # socket event names, tuple layouts, room-name helpers
│  └─ constants.ts               # METRICS order, limits, intervals
├─ server/src/
│  ├─ index.ts                   # bootstrap: mongo, express, socket.io, pipeline, optional embedded sim
│  ├─ config.ts
│  ├─ db/models/                 # User, Agent, Node, Alert, Incident, ChaosRun, Metric1s, Metric1m
│  ├─ db/seed.ts
│  ├─ http/
│  │  ├─ app.ts
│  │  ├─ middleware/             # auth.ts, requireRole.ts, agentKey.ts, tokenBucket.ts, errors.ts
│  │  └─ routes/                 # auth, ingest, metrics, nodes, alerts, incidents, chaos, meta, replay
│  ├─ pipeline/
│  │  ├─ dedup.ts
│  │  ├─ aggregator.ts
│  │  ├─ stateStore.ts
│  │  ├─ writer.ts
│  │  ├─ detector.ts
│  │  ├─ correlator.ts
│  │  ├─ loadShed.ts
│  │  └─ pipelineStats.ts
│  └─ realtime/
│     ├─ io.ts                   # server, namespaces, auth middleware
│     ├─ rooms.ts                # canJoin(user, room)
│     ├─ broadcaster.ts          # 1 Hz flush loop
│     └─ control.ts              # /control namespace for simulators
├─ simulator/src/
│  ├─ index.ts                   # CLI entry; also exports startSimulator() for embedded mode
│  ├─ world.ts                   # load model
│  ├─ agent.ts                   # batching, seq, retry and backoff
│  └─ chaos.ts                   # scenario implementations
├─ client/src/
│  ├─ main.tsx, App.tsx, routes.tsx
│  ├─ lib/                       # api.ts, socket.ts, clock.ts, format.ts
│  ├─ data/                      # SeriesBuffer.ts, TelemetryStore.ts, fleetState.ts, useSeries.ts, useRoom.ts, replayPlayer.ts
│  ├─ state/                     # authStore.ts, uiStore.ts, alertStore.ts
│  ├─ components/                # LiveChart, FleetHeatmap, TopologyMap, AlertFeed, StatTile, TimeScrubber, Presence, ...
│  ├─ pages/                     # Login, Overview, Topology, NodeDetail, Incidents, IncidentRoom, ChaosLab, Pipeline
│  └─ mocks/mockSocket.ts        # fake emitter so the UI can be built before the backend exists
└─ tools/stress/                 # load generator + N socket clients + report writer
```

---

## 4. Shared contract: the telemetry event

Defined in `shared/src/schemas.ts`. Both people depend on this; Person A writes it in task A1.

```ts
// Order matters: it is the column order on the wire and in the client buffers.
export const METRICS = ['cpu','mem','disk','netIn','netOut','lat','err','rps'] as const;
//                       %     %     %      kB/s    kB/s     ms    %     req/s

TelemetryEvent = {
  v: 1,
  nodeId: string,     // "ap-south-1a.orders-api.03"  (region+az . service . index), ≤ 64 chars, [a-z0-9.-]
  bootId: string,     // random 6 chars, regenerated when an agent restarts
  seq: number,        // integer ≥ 0, strictly increasing per (nodeId, bootId)
  ts: number,         // source time, epoch ms
  m: { cpu, mem, disk, netIn, netOut, lat, err, rps }   // finite numbers; cpu/mem/disk/err clamped 0–100
}

IngestBatch = {
  agentId: string,
  sentAt: number,                // epoch ms, used to estimate clock skew
  events: TelemetryEvent[]       // 1..500
}
```

Identity of an event: `nodeId:bootId:seq`. Identity of a stored/displayed data point: `(nodeId, bucketTs)`
where `bucketTs = floor(ts / 1000) * 1000`.

Rejection rules (count each in pipeline stats): schema failure · `ts` more than 5 s in the future ·
`ts` older than 60 s · unknown `nodeId` not owned by the agent · batch over 500 events or body over 256 kB.

---

## 5. MongoDB data model

| Collection | Shape | Indexes |
|---|---|---|
| `users` | `{ email, passwordHash, name, role: 'admin'|'sre'|'viewer', teams: string[] }` | unique `email` |
| `agents` | `{ agentId, keyHash, name, nodePrefix, ratePerSec, burst, enabled }` | unique `agentId` |
| `nodes` | `{ nodeId, serviceId, team, region, az, firstSeen, lastSeen }` | unique `nodeId`; `serviceId` |
| `metrics_1s` | `{ nodeId, ts: Date, n, cpu, mem, disk, netIn, netOut, lat, latMax, err, rps, rev }` | **unique `{nodeId:1, ts:1}`**; TTL on `ts`, 6 h |
| `metrics_1m` | same fields plus `cpuMax, memMax, latMax, errMax` | unique `{nodeId:1, ts:1}`; TTL on `ts`, 7 d |
| `alerts` | `{ key, nodeId, serviceId, team, metric, rule, severity, state: 'firing'|'acked'|'resolved', value, threshold, message, startedAt, ackedBy, resolvedAt, incidentId }` | `{state:1, startedAt:-1}`; `key`; `incidentId` |
| `incidents` | `{ title, state: 'open'|'resolved', startedAt, endedAt, lastAlertAt, epicenter, confidence, affected: string[], blastRadius: string[], alertIds, chaosRunId?, timeline: [{ ts, kind, text, userId? }] }` | `{state:1, startedAt:-1}` |
| `chaos_runs` | `{ scenario, target, params, startedAt, endedAt, startedBy, detectedAt?, detectedEpicenter?, correct? }` | `startedAt:-1` |

Design notes to repeat in the architecture doc:

- **Raw events are not stored; 1-second rollups are.** At 5 events/s per node, storing raw would be 5× the
  writes for no visual gain, and would exhaust a free Atlas cluster in hours.
- **Regular collection with a unique compound index rather than a time-series collection.** The unique index
  makes duplicates impossible at the storage layer and lets a late event correct a bucket with an upsert.
  Time-series collections compress better but cannot enforce uniqueness. This is a deliberate trade-off.
- TTL indexes cap storage: roughly 48 docs/s → about 1 M documents in the 6-hour window.

---

## 6. REST API (`/api/v1`)

All responses are JSON. Errors: `{ error: { code, message } }`. Auth: `Authorization: Bearer <jwt>` for
users, `x-agent-key: <key>` for agents.

### 6.1 Ingestion

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| POST | `/ingest` | agent key | Body `IngestBatch`. Returns `202 { accepted, duplicate, late, rejected }`. Returns `429` with `Retry-After` (seconds) when the token bucket is empty or the server is shedding load. Returns `400` with the first few zod issues on a malformed body. Valid events in a partly invalid batch are still accepted. |

### 6.2 Query

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/topology` | any | services, edges, teams, regions, node list `[nodeId, serviceId, region, az]` filtered by the user's teams |
| GET | `/metrics/node/:nodeId?from&to&res=auto|1s|1m` | team | **Columnar**: `{ nodeId, res, t: number[], cpu: number[], …, rev: number[] }`. `auto` picks `1s` for ranges ≤ 30 min, else `1m`. Hard cap 3600 points. |
| GET | `/metrics/service/:serviceId?from&to` | team | Same columnar shape, computed with a Mongo aggregation (`$match` → `$group` by `ts` → avg cpu/mem, sum rps, max lat) |
| GET | `/replay?from&to&services=a,b` | team | Columnar series for every node in those services at 1s, capped at 10 min, for the replay player |
| GET | `/alerts?state&limit&before` | team | Cursor-paginated alerts |
| POST | `/alerts/:id/ack` | sre, admin | Acks; broadcasts `alert:upd` |
| GET | `/incidents`, `/incidents/:id` | team | Incident plus alerts, timeline, chaos scorecard if linked |
| POST | `/incidents/:id/notes` | sre, admin | Adds a timeline note; broadcasts `incident:note` |
| GET | `/meta/stats` | any | Latest pipeline stats snapshot |

### 6.3 Auth and chaos

| Method | Path | Role | Behaviour |
|---|---|---|---|
| POST | `/auth/login` | public, 10 requests/min per IP | `{ email, password }` → `{ token, user }` (JWT, 12 h) |
| GET | `/auth/me` | any | Current user |
| GET | `/chaos/scenarios` | admin | Available scenarios with parameter descriptions |
| POST | `/chaos/start` | admin | `{ scenario, target?, durationSec? }` → creates `chaos_runs` doc, emits to `/control` |
| POST | `/chaos/stop` | admin | Stops all active scenarios |

Seed users (`npm run seed`): `admin@epicenter.dev` (admin, all teams) · `sre@epicenter.dev` (sre, all teams) ·
`payments@epicenter.dev` (viewer, `['payments']`). Passwords come from `.env`, never hard-coded in the repo.

---

## 7. Socket.IO contract

### 7.1 Namespaces and rooms

| Namespace | Who | Auth |
|---|---|---|
| `/dash` | Browser dashboards | JWT in `handshake.auth.token`, verified in namespace middleware |
| `/control` | Simulators | Simulator key in `handshake.auth.key`; server pushes chaos commands |

Rooms in `/dash` (helpers in `shared/src/wire.ts`):

| Room | Content | Rate |
|---|---|---|
| `fleet:<team>` | Changed-node deltas for that team's nodes | 1 Hz |
| `topology` | One aggregate row per service | 1 Hz |
| `node:<nodeId>` | Finalized 1-second points for one node, including corrections | 1 Hz, volatile |
| `service:<serviceId>` | Service aggregate points | 1 Hz, volatile |
| `alerts:<team>` | Alert lifecycle events | on event |
| `incident:<id>` | Incident updates, notes, presence | on event |
| `meta` | Pipeline stats | 1 Hz, volatile |

### 7.2 Client → server events (all with acknowledgement callbacks)

| Event | Payload | Ack |
|---|---|---|
| `sub` | `{ rooms: string[] }` | `{ joined: string[], denied: string[] }` |
| `unsub` | `{ rooms: string[] }` | `{ ok: true }` |
| `time` | `{ t0 }` | `{ t0, ts }` — the client derives clock offset and round-trip time |
| `client:stats` | `{ e2eP50, e2eP95, fps }` every 5 s | none; feeds the Pipeline page |
| `presence:hello` | `{ incidentId }` | `{ users }` |

Access rule (`realtime/rooms.ts → canJoin`): admins and SREs may join anything. Viewers may join
`fleet:<team>` and `alerts:<team>` only for their own teams, `node:` and `service:` rooms only when the
target belongs to one of their teams, and `incident:` rooms only when the incident touches their teams.
`sub` with a shorthand `fleet:*` expands to the user's permitted team rooms. Each socket is limited to
20 `sub`/`unsub` calls per 10 s and 100 joined rooms.

### 7.3 Server → client events and payload shapes

Positional arrays, not objects. Node and service ids are sent once in `/topology`; after that the wire
uses integer indexes into those lists.

| Event | Room | Payload |
|---|---|---|
| `fleet:delta` | `fleet:<team>` | `[tsSec, [nodeIdx, cpu, mem, status], …]` — **only nodes whose cpu or mem moved ≥ 1 point or whose status changed**. Values are rounded integers. `status`: 0 ok, 1 warn, 2 crit, 3 silent. |
| `topo:tick` | `topology` | `[tsSec, [svcIdx, cpuAvg, latP95, errAvg, rps, healthyNodes, totalNodes, status], …]` |
| `node:pt` | `node:<id>` | `[nodeIdx, ts, cpu, mem, disk, netIn, netOut, lat, err, rps, rev]` (one decimal place) |
| `svc:pt` | `service:<id>` | `[svcIdx, ts, cpuAvg, memAvg, latP95, errAvg, rps]` |
| `alert:new` / `alert:upd` | `alerts:<team>` | Alert object (low frequency, so a plain object is fine) |
| `incident:new` / `incident:upd` | `alerts:<team>` for every affected team, and `incident:<id>` | `{ id, title, state, epicenter, confidence, affected, blastRadius, startedAt, endedAt }` |
| `incident:note` | `incident:<id>` | `{ ts, kind, text, user }` |
| `presence` | `incident:<id>` | `{ users: [{ id, name }] }` |
| `meta:pt` | `meta` | Pipeline stats object (§8.7) |
| `chaos:upd` | `meta` | `{ active: [{ scenario, target, endsAt }] }` |

A full fleet snapshot is never pushed repeatedly. On joining `fleet:<team>`, the `sub` ack is followed by
one `fleet:delta` containing every node in that team; everything after that is deltas.

---

## 8. Backend design

### 8.1 Ingest path (`http/routes/ingest.ts`), in order

1. `agentKey` middleware: look up the agent by key hash (cache in a `Map` for 60 s). `401` if missing or disabled.
2. `loadShed.shouldShed()` → `429`, `Retry-After: 2`. See §8.4.
3. `tokenBucket(agent)`: capacity `agent.burst`, refill `agent.ratePerSec`, cost = number of events. Empty → `429` with the computed `Retry-After`.
4. `express.json({ limit: '256kb' })`, then `IngestBatch.safeParse`. Validate per event so one bad event does not reject the batch.
5. For each valid event: time-window check → `dedup.check(e)` → `aggregator.add(e)` → `stateStore.touch(e)`.
6. Respond `202` with counts. No database call happens on this path.

**Dedup (`pipeline/dedup.ts`)** — per `nodeId`: `{ bootId, maxSeq, seen: Set<number> }`.

```
check(e):
  s = state[e.nodeId]
  if !s or s.bootId != e.bootId: reset state for the new boot; accept
  if e.seq <= s.maxSeq - 1024:   return 'stale'       // far behind the window
  if s.seen.has(e.seq):          return 'duplicate'
  s.seen.add(e.seq); if e.seq > s.maxSeq: s.maxSeq = e.seq
  prune: delete seqs < maxSeq - 1024 (do it every 256 inserts)
  return e.seq < s.maxSeq ? 'accepted-out-of-order' : 'accepted'
```

### 8.2 Aggregator (`pipeline/aggregator.ts`)

- Bucket key `(nodeId, bucketTs)`; accumulator `{ n, sum[8], latMax, rev }`.
- A timer every 250 ms **finalizes** buckets whose `bucketTs + 1000 + GRACE_MS(2000) <= Date.now()`. Finalizing
  emits a `Point` (averages, `latMax`, `rev: 0`) to: writer, detector, stateStore, broadcaster.
- Finalized accumulators stay in memory for 60 s. A **late event** for a finalized bucket updates the
  accumulator, increments `rev`, and re-emits the point as a correction. Corrections go to the writer and
  to `node:<id>` rooms; they do not re-run the detector.
- A second accumulator per `(nodeId, minute)` produces `metrics_1m` points when the minute closes.
- Net effect: live charts run about 3 s behind wall-clock. That is the price of correct ordering; say so in the demo.

### 8.3 Writer (`pipeline/writer.ts`)

- Buffers points; flushes every 1000 ms or at 1000 points, whichever comes first.
- `Metric1s.collection.bulkWrite(ops, { ordered: false })` where each op is
  `updateOne({ nodeId, ts }, { $set: point }, { upsert: true })`. Upsert on the unique key makes replays,
  retries and corrections idempotent.
- Records batch size and write latency in pipeline stats.
- One flush in flight at a time. The buffer is capped at 20 000 points; beyond that the oldest are dropped and counted (`writeDropped`).

### 8.4 Backpressure (`pipeline/loadShed.ts`)

Three independent mechanisms, each visible on the Pipeline page:

1. **Ingest shedding.** `perf_hooks.monitorEventLoopDelay()` sampled every 500 ms. If p99 lag > 150 ms or the
   writer buffer is > 75% full, `shouldShed()` returns true for the next second and ingest replies `429`.
2. **Agent cooperation.** On `429` the simulator agent waits `Retry-After`, then sends a batch in which
   samples older than 5 s have been thinned to one per second per node. Agent buffers are bounded at 2000 events.
3. **Outbound.** Chart streams use `socket.volatile.emit`, so a slow browser skips frames instead of making
   the server queue them. The client's gap-fill (§9.2) repairs any hole from history.

### 8.5 Broadcaster (`realtime/broadcaster.ts`)

One loop at 1 Hz:

- For each team: diff `stateStore` against the last-sent snapshot for that team, build `fleet:delta`, skip the emit if nothing changed.
- Build `topo:tick` from per-service aggregates (p95 latency = 95th percentile across the service's node points for that second).
- Emit `meta:pt`.

Point events (`node:pt`, `svc:pt`) are emitted immediately on finalize, but only if
`io.of('/dash').adapter.rooms.get(room)?.size > 0` — no serialization work for rooms nobody is in.

### 8.6 Anomaly detection (`pipeline/detector.ts`)

Runs on each finalized point, per `(nodeId, metric)` for `cpu, mem, lat, err, netIn`.

```
state: { mean, variance, warm, streak, okStreak }
MIN_DELTA = { cpu: 15, mem: 10, lat: 40, err: 2, netIn: 500 }   // ignore statistically odd but tiny moves

zscore rule:
  if warm >= 30:
    z = (x - mean) / sqrt(variance + 1e-6)
    hit = |z| > 4 and |x - mean| > MIN_DELTA[metric]
  streak = hit ? streak + 1 : 0
  if streak == 3 → fire(rule 'zscore', severity warn; crit if |z| > 8)
  if !hit: update baseline with α = 0.05      // baseline is frozen while anomalous
           mean += α(x − mean); variance = (1 − α)(variance + α(x − mean)²); warm++

threshold rule:  cpu > 90 ×10 pts → crit · mem > 92 ×10 → crit · err > 5 ×5 → crit · lat > 3 × service SLO ×5 → warn
heartbeat rule:  timer every 1 s; now − lastSeen > 5 s → status 'silent', fire crit 'heartbeat'
trend rule:      least-squares slope of mem over the last 120 points; if slope > 0, R² > 0.8 and
                 (95 − mem) / slope < 300 s → fire warn 'predictive': "memory exhausts in ~Xm Ys"
resolve:         rule condition false for 15 consecutive points → state 'resolved'
```

Alert `key = nodeId|metric|rule`. One firing alert per key (in-memory map; persisted to `alerts` on
state changes only). Node `status` = highest severity among its firing alerts.

### 8.7 Correlator (`pipeline/correlator.ts`)

```
onAlertFired(a):
  inc = open incident where a.serviceId ∈ inc.affected ∪ neighbours(inc.affected)   // neighbours: either edge direction
        and now − inc.lastAlertAt < 60 s
  if none: create incident { affected: [a.serviceId], startedAt: a.startedAt }
  attach alert; recompute:
    A          = services with ≥ 1 firing alert in this incident
    candidates = { s ∈ A : no service in dependsOn*(s) is in A }      // deepest anomalous services
    epicenter  = candidate with the earliest alert onset (tie → highest severity, then highest z)
    blastRadius = all services that transitively depend on epicenter
    confidence = |A ∩ (blastRadius ∪ {epicenter})| / |A|
  title = "<epicenter>: <dominant rule/metric> — <n> services affected"
  emit incident:new or incident:upd; append to timeline

onAlertResolved: if the incident has no firing alerts for 30 s → resolve, set endedAt.

Chaos scorecard: if a chaos run started within the 120 s before incident.startedAt, link them and set
  detectedAt, detectedEpicenter, correct = (detectedEpicenter == run.target service).
```

### 8.8 Pipeline stats (`pipeline/pipelineStats.ts`)

Counters reset each second, plus gauges; emitted as `meta:pt` and served at `/meta/stats`:

```
{ ts, eps, accepted, duplicate, outOfOrder, lateCorrected, stale, rejected, shed429,
  bucketsOpen, writeBatch, writeMs, writeBuffer, writeDropped,
  socketsDash, rooms, emitsPerSec, bytesOutPerSec,          // bytes: sum of encoded payload lengths in broadcaster
  loopLagP99, rssMb, clientE2eP95 }                         // clientE2eP95: median of values reported via client:stats
```

### 8.9 Simulator (`simulator/`)

- `world.ts`: builds 48 nodes from `shared/topology.ts` (node counts per service: gateway 6, auth 4,
  catalog 6, orders 6, payments 4, db 4, cache 4, queue 4, worker 10; spread over 3 regions).
- **Load model, ticked at `--hz` (default 2):** gateway rps = daily sine + noise. Rps propagates down the
  dependency edges by fixed call fractions. Per node: `cpu = base + k·rps_share + OU noise`;
  `lat(service) = ownBase·f(cpu) + Σ fraction·lat(dependency)`; `err` rises when cpu > 85 or a dependency's
  err is high; `mem` drifts slowly; `netIn/netOut ∝ rps`. Because latency and errors propagate through the
  graph, a fault at one service produces a cascade without scripting it.
- `agent.ts`: one logical agent per region. Collects events, flushes a batch every 500 ms over keep-alive
  HTTP, honours `429`, retries on network error **with the same `seq` values** (so retries exercise dedup).
- Connects to `/control` with `socket.io-client`; handles `chaos:start` / `chaos:stop`.
- Runs standalone (`npm run sim -- --url http://localhost:4000 --hz 2`) or embedded in the server
  process when `EMBEDDED_SIM=true` (still posts over real HTTP to its own port, so the hosted demo uses the real ingest path).

Chaos scenarios (`chaos.ts`):

| Scenario | Effect in the model | Expected detection |
|---|---|---|
| `cpu-spike` | +60 cpu on one node | zscore then threshold alert, single-service incident |
| `memory-leak` | mem +0.25/s on one node | **predictive** alert before the threshold alert |
| `node-kill` | node stops emitting | heartbeat alert within ~5–8 s; hex turns "silent" |
| `slow-db` | db latency ×8 | cascade into auth, catalog, orders, worker, gateway; epicenter = db |
| `cache-outage` | cache err 60% | cascade into auth and catalog; epicenter = cache |
| `traffic-surge` | gateway rps ×10 and sim `hz` ×5 | fleet-wide load; Pipeline page shows eps jump and possible shedding |
| `duplicate-storm` | every batch sent 3×, events shuffled, 10% delayed by 1.5 s | no visual glitch; `duplicate` / `outOfOrder` / `lateCorrected` counters climb |
| `malformed-flood` | 200 req/s of invalid bodies from a second agent key | `rejected` and `shed429` climb; dashboards unaffected |

---

## 9. Frontend design

### 9.1 Pages

| Route | Page | Content |
|---|---|---|
| `/login` | Login | Seed-user quick-fill buttons for the demo |
| `/` | **Overview** | Stat tiles (nodes healthy, total rps, p95 latency, open incidents) · fleet heatmap grouped by service · live alert feed · open-incident banner |
| `/topology` | **Topology** | Dependency map with live rps on edges and status on nodes; during an incident the epicenter pulses and edges in the blast radius animate outward |
| `/node/:id` | **Node detail** | Four synced uPlot charts (cpu+mem, latency, errors, network) · range picker (5 m, 15 m, 1 h, 6 h) · "compare with 1 h ago" overlay · alert history |
| `/incidents`, `/incidents/:id` | **Incident room** | Header with epicenter and confidence · time scrubber with play / speed / Go Live · topology and heatmap driven by the scrubber · timeline with notes · presence avatars · chaos scorecard |
| `/chaos` | **Chaos Lab** (admin) | Scenario cards, target picker, active runs, scorecard history |
| `/pipeline` | **Pipeline X-ray** | Flow diagram of ingest → dedup → aggregate → write → broadcast with live counters on each stage, and sparklines of eps, latency, loop lag |

### 9.2 Data layer — the part that earns the "no duplicates" and "stays responsive" marks

**Rule: telemetry never goes into React state.** React state is for UI (selected range, open panels, auth).

- `SeriesBuffer` (`data/SeriesBuffer.ts`): fixed capacity (default 3600), a `Float64Array` for `t` and one
  `Float32Array` per metric, kept sorted by `t`.
  `upsert(t, values, rev)`: append if `t` is newest (evict oldest when full); otherwise binary-search —
  overwrite if `t` exists and `rev >=` stored rev, else insert in order. **This single method is the dedup:
  history rows, live points, corrections and reconnect gap-fills all go through it, in any order.**
- `TelemetryStore`: `Map<roomKey, SeriesBuffer>` plus a dirty set. One `requestAnimationFrame` loop redraws
  only dirty, visible charts, at most once per frame. Rendering pauses when `document.hidden`.
- `useSeries(roomKey, range)`:
  1. `socket.emit('sub')` first, so live points start landing in the buffer.
  2. Fetch history over REST for `range`.
  3. Bulk `upsert` the history. Overlap between history and live resolves by key.
  4. On socket `connect` after a disconnect: refetch `[lastT − 5 s, now]` and upsert (gap-fill).
  5. On unmount: ref-counted `unsub` (two charts on one room share one subscription).
- `useRoom(room)` with `IntersectionObserver`: off-screen panels unsubscribe after 2 s.
- `fleetState.ts`: `Uint8Array` columns (cpu, mem, status) indexed by `nodeIdx`, mutated by `fleet:delta`; the
  heatmap canvas reads them in its rAF draw.
- `clock.ts`: `{ mode: 'live' | 'replay', now(), speed }`. Components read time from the clock, never from `Date.now()`.
- `replayPlayer.ts`: loads `/replay` into a separate `TelemetryStore`, advances `clock` on a timer, and exposes
  `frameAt(ts)` so the heatmap and topology render the recorded state. Charts show the whole window with a
  cursor line. "Go Live" switches the clock back and swaps in the live store.
- End-to-end latency: `time` handshake gives clock offset; for each `fleet:delta`, latency = `now + offset − tsSec·1000`;
  keep a rolling p50/p95 and report via `client:stats`.

### 9.3 Components

| Component | Notes |
|---|---|
| `LiveChart` | Thin wrapper around uPlot. Receives a `SeriesBuffer`, calls `setData` from the rAF loop. Cursor sync across charts on a page. Optional ghost series for the baseline overlay. |
| `FleetHeatmap` | One `<canvas>`. Hexagons grouped under service labels, colour = cpu bucket (5-step sequential scale), outline = status, striped fill = silent. Hit-testing for tooltip and click-through to node detail. Never relies on colour alone: status also shows as an icon in the tooltip and a count in the legend. |
| `TopologyMap` | `@xyflow/react`, fixed layered layout from `shared/topology.ts`. Custom node: name, status ring, rps, p95. Edge width ∝ rps; CSS dash animation on blast-radius edges; ripple on the epicenter. |
| `AlertFeed` | Virtualized list; new items highlight briefly; ack button for sre/admin. |
| `TimeScrubber` | Range input over the incident window with alert markers, play/pause, 1×/4×/16×, Go Live. |
| `StatTile` | Number, unit, sparkline; number updates are throttled to 1 Hz. |
| `ConnectionBadge` | Live / reconnecting / replay, plus the measured latency. |

### 9.4 Visual direction

Dark control-room theme, one neutral surface scale, a single accent colour for interactive elements, and
status colours reserved strictly for status (ok / warn / crit / silent) so they keep their meaning.
Tabular-numeral font for all metrics. Layout works at 1280 px and collapses to one column on a phone
(judges often open the hosted link on mobile). Every async surface has a loading and an empty state.

---

## 10. Stress test (`tools/stress`)

`npm run stress -- --url <api> --nodes 500 --hz 5 --clients 200 --duration 120`

- Registers a stress agent, generates `nodes × hz` events/s through the real ingest endpoint.
- Opens `clients` Socket.IO connections; each subscribes to its fleet rooms plus 3 random `node:` rooms.
- Measures: events sent / accepted / 429, delivery latency p50/p95/p99 across clients, messages and bytes
  received per client, and polls `/meta/stats` for loop lag, RSS and write latency.
- Writes a table per run to `docs/BENCHMARKS.md` with the machine spec and the exact command.

Run three profiles — baseline (48 × 2 Hz, 10 clients), heavy (500 × 5 Hz, 200 clients), overload
(2000 × 5 Hz, to show shedding engaging and recovering). **Report what you measure, including where it
breaks.** A graph of graceful degradation is more convincing to a judge than a round number.

---

## 11. Environment and deployment

`.env.example`:

```
PORT=4000
MONGODB_URI=
JWT_SECRET=
CLIENT_ORIGIN=http://localhost:5173
SIM_KEY=                 # used by simulators for /control and as the seed agent key
EMBEDDED_SIM=false
SEED_ADMIN_PASSWORD=
SEED_SRE_PASSWORD=
SEED_VIEWER_PASSWORD=
VITE_API_URL=http://localhost:4000
```

- **MongoDB Atlas** free cluster; create it in hour 0 and use it from the start so there is no late migration.
- **Render** web service for `server` with `EMBEDDED_SIM=true` (a free instance sleeps when idle — open the
  URL a minute before the demo; check current free-tier limits when you deploy).
- **Vercel** for `client` (static build). Socket.IO cannot run on Vercel's serverless functions, which is why the API is on Render.
- Socket.IO client: `transports: ['websocket']`, token passed in `auth`. CORS restricted to `CLIENT_ORIGIN`.
- **Deploy at hour 20, not hour 46.** Cross-origin sockets and environment variables are where hackathon deployments fail.

---

## 12. Work split

### 12.1 Ownership

| | **Person A — Pipeline & Simulation** | **Person B — Real-time Client & Experience** |
|---|---|---|
| Owns | `shared/`, `server/`, `simulator/`, `tools/stress` | `client/`, `docs/`, README, demo video |
| Explains to judges | Ingest, dedup, aggregation, backpressure, detection, correlation, rooms | History/live merge, rendering strategy, subscriptions, replay, UX |

Rules that keep two people (and two Claude Code sessions) from colliding:

- `shared/` is written by A in the first two hours and then changed only by agreement.
- B builds against `client/src/mocks/mockSocket.ts` until A's walking skeleton lands (hour 5), then switches by one env flag.
- Branches `a/<task>` and `b/<task>`, merged to `main` at each sync point. Commit small and often — the
  rules require the repository to show work done during the hackathon, and commit history is the evidence.
- Both must be able to explain all of it (AI usage policy). At each sync, each person walks the other through what they merged.

### 12.2 Person A tasks

| ID | Task | Details | Done when |
|---|---|---|---|
| A1 | Scaffold + shared contract | Workspaces, tsconfig, root scripts, `.env.example`, `CLAUDE.md`. Write all of `shared/` per §4 and §7 and the topology in §1.3. | `npm run dev` starts an empty server; client can import `@epicenter/shared` |
| A2 | Models, seed, auth | §5 models with indexes; `seed.ts` (users, agents, nodes); `/auth/login`, `/auth/me`; `auth` and `requireRole` middleware; helmet, cors, error handler | Login returns a JWT; indexes exist in Atlas |
| A3 | Simulator v1 | `world.ts` load model, `agent.ts` batching; no chaos yet | Prints batches at the configured rate; values look plausible |
| A4 | Ingest + dedup + aggregator | §8.1, §8.2 with vitest for dedup (duplicate, reorder, boot reset) and aggregator (grace, late correction → rev) | Tests pass; `/ingest` returns correct counts |
| A5 | Socket.IO `/dash` + broadcaster | §7, §8.5: auth middleware, `sub`/`unsub` with `canJoin`, `fleet:delta`, `topo:tick`, `node:pt`, `time` | **Walking skeleton:** sim → ingest → socket; B's heatmap moves with real data |
| A6 | Writer + history API | §8.3; `/topology`, `/metrics/node`, `/metrics/service`, `/replay` (columnar) | Sending every batch twice leaves document counts unchanged; history returns sorted, unique `t` |
| A7 | Detector + alerts | §8.6 with vitest per rule; alert persistence; `alert:new`/`alert:upd`; alert REST | Each rule fires and resolves in tests |
| A8 | Chaos | `/control` namespace, `chaos.ts` scenarios, chaos REST, `chaos_runs` | `slow-db` produces a visible cascade |
| A9 | Correlator + incidents | §8.7 with vitest on the topology (db fault → epicenter db; cache fault → epicenter cache; gateway fault → epicenter gateway); incident REST and events; notes; presence; scorecard | `slow-db` yields one incident with epicenter `db` |
| A10 | Backpressure + stats | §8.4, §8.8; token bucket; socket rate limits; `meta:pt` | `malformed-flood` and `traffic-surge` show up in stats and the server stays responsive |
| A11 | Stress tool + benchmarks | §10 | `docs/BENCHMARKS.md` has three real runs |
| A12 | Deploy API | Render + Atlas, `EMBEDDED_SIM=true` | Hosted API streams to the hosted client |

### 12.3 Person B tasks

| ID | Task | Details | Done when |
|---|---|---|---|
| B1 | Client scaffold | Vite, Tailwind, Router, theme tokens, app shell with nav, `api.ts`, `socket.ts`, auth store, protected routes, Login page | Can log in against A2 (or a mock) and see the shell |
| B2 | Mock socket | `mockSocket.ts` emitting `fleet:delta`, `topo:tick`, `node:pt`, alerts in the §7.3 shapes | All later UI work can proceed without the backend |
| B3 | Data layer | §9.2: `SeriesBuffer` (with vitest: append, overwrite by rev, out-of-order insert, eviction), `TelemetryStore`, rAF loop, `useSeries`, `useRoom`, `fleetState`, `clock` | Tests pass; feeding the same points twice in shuffled order yields identical buffers |
| B4 | Overview page | `FleetHeatmap`, `StatTile`, `AlertFeed`, `ConnectionBadge` | Smooth with the mock at 500 nodes |
| B5 | Node detail | `LiveChart`, range picker, history + live merge, reconnect gap-fill, baseline overlay | Kill and restore the network in DevTools: the chart heals with no gap and no doubled points |
| B6 | Topology page | `TopologyMap` with live `topo:tick`, incident state, blast-radius animation | Epicenter and spread are obvious within two seconds of looking |
| B7 | Incidents + replay | Incident list and room, `replayPlayer`, `TimeScrubber`, timeline notes, presence, scorecard | Scrub, play at 16×, Go Live — all without a reload |
| B8 | Chaos Lab | Scenario cards, target picker, active runs, admin-only route guard | Every scenario can be started and stopped from the UI |
| B9 | Pipeline X-ray | Stage diagram with live counters, sparklines, client-side latency reporting | Counters move during `duplicate-storm` |
| B10 | Polish | Empty/loading/error states, responsive layout, keyboard focus, toasts for new incidents, team-scoped view check with the viewer account | Viewer account sees only payments nodes everywhere |
| B11 | Deploy client | Vercel, env vars, test from a phone | Hosted URL works on mobile data |
| B12 | Docs | README (every item in the deliverables list), `docs/ARCHITECTURE.md` with Mermaid architecture and data-flow diagrams, data model, real-time mechanism, optimizations; attribution table | A stranger can clone, seed and run from the README alone |
| B13 | Demo video | Script in §14; record, cut to under 5 minutes | Uploaded and linked in the README |

### 12.4 Timeline

| Hours | Person A | Person B | Sync point |
|---|---|---|---|
| 0–2 | A1 | B1 (after A1's scaffold lands at ~h1) | **H2: contract frozen.** Both read §4–7 together. |
| 2–5 | A2, A3 | B2, B3 | |
| 5–9 | A4, A5 | B4 | **H9: walking skeleton.** Real data on the heatmap. |
| 9–14 | A6 | B5 | **H14: history + live merge works end to end.** |
| 14–20 | sleep (stagger: A first) | sleep (B second), B6 on the mock | |
| 20–24 | A7, A12 (first deploy) | B6, B11 (first deploy) | **H24: MVP hosted.** Everything below this line is P0. |
| 24–30 | A8, A9 | B7 | **H30: slow-db → incident → replay works.** |
| 30–35 | A10 | B8, B9 | |
| 35–40 | sleep, staggered | sleep, staggered | |
| 40–44 | A11, bug fixes | B10, B12 | **H44: feature freeze.** Bug fixes only after this. |
| 44–47 | Redeploy, README review, rehearse | B13 video | |
| 47–48 | Submit with an hour of margin | | |

### 12.5 Priority tiers — what to cut if you are behind

- **P0 (must exist at H24):** auth · simulator · ingest with validation, dedup and rate limit · aggregation ·
  Mongo writes · rooms · heatmap · node charts with history + live merge · threshold alerts · hosted.
  This alone satisfies every mandatory requirement.
- **P1 (the differentiators, in this order):** chaos scenarios → z-score/heartbeat detection → correlator and
  topology animation → Pipeline X-ray → incident replay → stress report.
- **P2 (only if ahead):** predictive memory alert · baseline overlay · presence and notes · team-scoped viewer demo · `metrics_1m`.

If replay is at risk at H30, cut it down to "open the incident window in the node charts" — the same
history API, no player.

---

## 13. Verification checklist (run before recording)

1. Fresh clone → `npm install` → `npm run seed` → `npm run dev` → `npm run sim` works from the README alone.
2. Two browsers, admin and payments viewer: the viewer's network tab shows only `fleet:payments` traffic.
3. Send every batch twice (`duplicate-storm`): charts unchanged, Mongo counts unchanged, counters rise.
4. DevTools offline for 20 s on node detail, then online: no gap, no duplicate points.
5. `slow-db`: one incident, epicenter `db`, scorecard marks it correct.
6. `node-kill`: heartbeat alert, silent hex, resolves after the scenario stops.
7. `malformed-flood`: `rejected` climbs, UI latency badge stays steady.
8. Chrome Performance recording on Overview for 30 s: no long tasks from telemetry updates.
9. Hosted URL passes steps 2, 5 and the phone check.
10. `npm test` green.

---

## 14. Demo video script (target 4:30)

| Time | Shot | Line to land |
|---|---|---|
| 0:00–0:25 | Overview, heatmap alive | "48 servers, 9 services, every hex is a live node. This is Epicenter." |
| 0:25–1:00 | Pipeline X-ray | The path of an event: batch → validate → dedup → 1 s aggregate → Mongo bulk upsert → room delta. Show the counters. |
| 1:00–1:40 | Two browsers side by side, admin and payments viewer; open a node on one | Independent subscriptions; the viewer receives only its team's room; payload is a short array of changed nodes. |
| 1:40–2:40 | Chaos Lab → `slow-db` → Topology | Cascade appears, alerts group into one incident, epicenter pulses on `db`, scorecard shows time-to-detect. |
| 2:40–3:20 | Incident room | Scrub back, replay at 16×, Go Live. "History and live are the same store keyed by node and timestamp, so there is nothing to duplicate." |
| 3:20–3:50 | `duplicate-storm` then DevTools offline/online on node detail | Counters climb, chart does not flinch; reconnect heals the gap. |
| 3:50–4:20 | `docs/BENCHMARKS.md` and the overload run | Measured events/s, clients, p95 latency, and shedding engaging then recovering. |
| 4:20–4:30 | Architecture diagram, hosted URL | Stack and links. |

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Scope: this is a lot for 48 hours | Tiers in §12.5. P0 is a complete submission; each P1 item is independently demoable. |
| Contract drift between the two halves | `shared/` types imported by both; tuple layouts defined once in `wire.ts`. |
| Atlas free-tier storage or write limits during stress runs | TTL indexes; run heavy and overload profiles against local MongoDB and say so in the benchmark notes. |
| Free hosting CPU is small | Embedded sim defaults to 48 nodes at 1 Hz when hosted; `traffic-surge` is capped in hosted mode. |
| Correlator names the wrong epicenter | Unit tests on the three canonical faults; show `confidence`; the scorecard reports misses honestly. |
| Judges ask "did AI write this?" | Each person explains their own half plus one module of the other's at every sync point. |
