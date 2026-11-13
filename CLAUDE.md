# Epicenter — conventions

**Before coding, read `implementation_plan.md` §4–7 (the shared contract) and the task you were given in §12.**

- Two owners: Person A owns `shared/`, `server/`, `simulator/`, `tools/stress`; Person B owns `client/`, `docs/`, README.
  Do not edit the other person's area without telling them.
- `shared/` is the contract (frozen at H2). Change it only by agreement, and update both sides in the same PR.
  - `shared/src/topology.ts` — services, teams, edges, regions, canonical 48-node fleet, graph helpers.
  - `shared/src/schemas.ts` — zod schemas + REST DTO types.
  - `shared/src/wire.ts` — Socket.IO event names, room helpers, tuple layouts, typed event maps.
  - `shared/src/constants.ts` — METRICS order, limits, intervals. Never hard-code these elsewhere.
- TypeScript everywhere, ESM, strict. Packages import `@epicenter/shared` (TS source, no build step; tsx on the
  server, Vite on the client). Use extensionless relative imports.
- Telemetry never goes into React state (§9.2). No DB calls on the ingest hot path (§8.1).
- Tests: vitest, pure logic only, files named `*.test.ts` next to the code. `npm test` must stay green.
- Branches `a/<task>` / `b/<task>`; small, frequent commits.
- Secrets only in `.env` (repo root; see `.env.example`). Never commit passwords or keys.

Commands: `npm run dev` · `npm run dev:server` · `npm run dev:client` · `npm run sim` · `npm run seed` ·
`npm run stress` · `npm test` · `npm run typecheck`.

Contract notes (decided in A1, beyond the plan text):
- `worker` dependsOn `[queue, db]` (worker consumes from queue), so a db fault's blast radius is
  auth, catalog-api, orders-api, worker, edge-gateway — matching §8.9.
- `nodeIdx` is server-assigned (seeded fleet first in `buildFleet()` order, then dynamic nodes) and global, so
  GET /topology node tuples are `[nodeIdx, nodeId, serviceId, region, az]`. `svcIdx` = position in `SERVICES`.
- `PipelineStats` adds `shedding: boolean` to the §8.8 fields.
