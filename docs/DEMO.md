# Recording the demo video

Target length 4:30, hard limit 5:00. The submission asks the video to show: the app and its main features,
continuous ingestion with live dashboard updates, several clients receiving their own updates, history
alongside live data, and the performance work and what is unusual about Epicenter. Every shot below maps to
one of those.

## Before recording

**System**
- Record against the real stack (`npm run dev`, `npm run sim`, seeded database) once alerts, incidents and
  chaos are on the server. Until then, the incident and Chaos Lab shots can be recorded in mock mode
  (`npm run dev:mock -w @epicenter/client`); say so in the voice-over rather than hide it.
- Let the simulator run for **at least 15 minutes** first, so node charts have history and the "1 h ago"
  overlay has something to compare (an hour if you want the 1 h range full).
- Stop any running chaos run. Check the Overview shows all nodes healthy.
- Run `npm run stress` beforehand so `docs/BENCHMARKS.md` has real numbers for the last shot.

**Screen**
- 1920×1080, browser zoom 110 %, dark OS theme, notifications off, bookmarks bar hidden.
- Two browser windows side by side for shot 3: **Chrome** signed in as `admin@epicenter.dev`, a **private
  window** signed in as `payments@epicenter.dev`.
- In the admin window, open DevTools → Network → filter **WS** → select the socket → **Messages**, then close
  DevTools again; you will reopen it in shot 3.
- Recorder: OBS (or any screen recorder) at 30 fps, microphone checked. Record each shot as its own clip;
  cutting is easier than re-takes.

## Shot list

| # | Time | Screen | Do | Say (roughly) |
|---|---|---|---|---|
| 1 | 0:00–0:25 | Overview, admin | Let the heatmap breathe. Hover a hexagon. | "Forty-eight servers, nine services, three regions. Every hexagon is a live node, updated through Socket.IO. This is Epicenter." |
| 2 | 0:25–1:00 | Pipeline X-ray | Point along the six stages left to right. | "One event's path: an agent batches it, the server validates it, drops duplicates, folds it into a one-second bucket, writes it to MongoDB in a bulk upsert, and broadcasts only what changed. Every counter here is live." |
| 3 | 1:00–1:40 | Both windows | Open the same page in both. In the admin window open DevTools → WS messages and show a `fleet:delta` frame. Open a node in the admin window. | "Two clients, independent subscriptions. The viewer from the payments team only joins the payments rooms, and the server refuses everything else. Payloads are short arrays of only the nodes that changed." |
| 4 | 1:40–2:40 | Chaos Lab → Topology | Chaos Lab: *Slow database*, target **Database**, Start. Click *Watch the topology*. Wait for the ripple. Back to Chaos Lab: show the scorecard row. | "I slow the database. Latency spreads to every service that calls it. Instead of fifteen separate alerts, Epicenter groups them into one incident, names the database as the epicenter, and animates the blast radius. The scorecard says how fast it was detected and whether the root cause was right." |
| 5 | 2:40–3:20 | Incident room | Open the incident. Press **Start**, pick **16×**, Play. Drag the scrubber. Press **Go Live**. | "Every incident is a recording. I can replay it at sixteen times speed, scrub to the moment the epicenter was found, and go back to live with no gap and no duplicate. History and live share one store keyed by node and timestamp, so there is nothing to merge twice." |
| 6 | 3:20–3:50 | Chaos Lab → Pipeline, then a node | Start *Duplicate storm*; on Pipeline, show *Dupes* climbing. Open a node, 5 m range, open the console and run `epicenter.drop(15000)`; watch the badge go to *Offline* and back. | "Every batch is now sent three times, shuffled. Duplicates climb, the charts do not flinch. And if the connection drops, the chart fills the hole from history when it comes back." |
| 7 | 3:50–4:20 | `docs/BENCHMARKS.md` | Scroll the three runs. | Read the measured numbers: events per second, connected clients, p95 delivery latency, and where shedding started and recovered. |
| 8 | 4:20–4:30 | `docs/ARCHITECTURE.md` diagram, then the hosted URL | Show the system diagram. | "MongoDB, Express, React, Node and Socket.IO. The code, the architecture and the hosted app are linked in the README." |

## After recording

- Cut to under 5:00. Add captions for the numbers (eps, latency) if they are hard to read.
- Upload as **unlisted** (YouTube or Drive with link sharing), then put the link in the README's table at the
  top.
- Watch it once on a phone: the judges might.
