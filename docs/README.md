# Epicenter

Real-time observability that finds where the fire started, shows how far it spread, and replays the incident.
MERNIFY 2026 · High-Throughput Streams & Telemetry.

> Work in progress. Full README (setup, deliverables, attribution table) lands in task B12.

## Quick start

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, JWT_SECRET, SIM_KEY, seed passwords
npm run dev            # server on :4000 (+ client once scaffolded)
npm test
```

See `implementation_plan.md` for the design and work split.
