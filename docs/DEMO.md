# Recording the demo video

Target length 4:30, hard limit 5:00. The submission asks the video to show: the application and its main
features, continuous ingestion with live dashboard updates, several clients receiving their own updates,
historical data alongside live data, and the performance work and what is unusual about Epicenter. Every
shot below maps to one of those (last column).

## Where to record

**Record against the local real stack** (`npm run dev` + `npm run sim`, local MongoDB). It is the smoothest:
the hosted API runs on Render's free instance, which has a fraction of a CPU, sleeps when idle and shows
brief load-shedding blips on the Pipeline page. Show the hosted site in the last shot, so the judges see it
is live (<https://epicenter-one.vercel.app>).

If you record on the hosted site instead, open <https://epicenter-api-lsi0.onrender.com/api/v1/health> a
couple of minutes before, and say in the voice-over that the API runs on a free instance.

## Before recording

**System (start 20 minutes before)**
- `npm run dev` and `npm run sim`, seeded database. Let the simulator run for **at least 15 minutes**, so
  node charts have history and the "1 h ago" baseline has something to compare.
- **Make a past incident for the analysis panel.** About 10 minutes before recording, run *Slow database*
  in the Chaos Lab for 60 s, open its incident and add a note such as "Failed over to the replica". Let it
  resolve. In shot 6 the new incident will list it under *Similar past incidents*, with that note. Do not run
  it closer than 5 minutes to the recording: the detector needs a few minutes of normal data again, or
  detection of the next fault is slow.
- Stop any running chaos run. The Overview should show all nodes healthy.
- `docs/BENCHMARKS.md` already has the measured runs; nothing to run for shot 8.

**Browser and screen**
- 1920×1080, browser zoom 110 %, dark OS theme, bookmarks bar hidden.
- **Desktop notifications on for Epicenter, everything else quiet.** In the admin window open the
  **Display** menu → *Desktop notifications* → allow. Turn on the OS's do-not-disturb *for other apps* only,
  or close chat apps, so the only notification on screen is Epicenter's.
- Two browser windows side by side for shot 3: **Chrome** signed in as `admin@epicenter.dev`, a **private
  window** signed in as `payments@epicenter.dev`.
- In the admin window, open DevTools → Network → filter **WS** → select the socket → **Messages**, then close
  DevTools again; you will reopen it in shot 3.
- Have a second app (an editor or a terminal) to switch to in shot 5, so the notification arrives while the
  dashboard is in the background.
- Recorder: OBS (or any screen recorder) at 30 fps, microphone checked. Record each shot as its own clip;
  cutting is easier than re-takes.

## Shot list

| # | Time | Screen | Do | Say (roughly) | Shows |
|---|---|---|---|---|---|
| 1 | 0:00–0:20 | Overview, admin | Let the heatmap breathe. Hover a hexagon. | "Forty-eight servers, nine services, three regions. Every hexagon is a live node, updated through Socket.IO. This is Epicenter: it finds where the fire started." | app, live updates |
| 2 | 0:20–0:50 | Pipeline X-ray | Point along the six stages left to right. | "One event's path: an agent batches it, the server validates it, drops duplicates, folds it into a one-second bucket, bulk-writes it to MongoDB and broadcasts only what changed. Every counter here is live." | continuous ingestion |
| 3 | 0:50–1:25 | Both windows | Open the Overview in both. In the admin window open DevTools → WS messages and show a `fleet:delta` frame. | "Two clients, independent subscriptions. The payments viewer only joins the payments rooms; the server refuses everything else. Payloads are short arrays of only the nodes that changed." | multiple clients, selective broadcast |
| 4 | 1:25–1:55 | A node, admin | Open a node, 15 m range; point at the dashed "1 h ago" line. Console: `epicenter.drop(15000)`; the badge goes *Offline* and back, and the chart fills the hole. | "Fifteen minutes of history from MongoDB, with the live stream appended to the same buffer, keyed by timestamp. If the connection drops, it re-fetches what it missed: no gap, no duplicate point." | history + live |
| 5 | 1:55–2:40 | Chaos Lab → another app → notification → incident room | Chaos Lab: *Slow database*, target **Database**, Start. Switch to the other app. When the desktop notification "New incident: Database" appears, click it. | "I slow the database and switch away, like an engineer working on something else. Latency spreads to every service that calls it. Epicenter groups the alerts into one incident, names the database as the epicenter, and notifies me. One click takes me straight to it." | anomaly detection, alerts, originality |
| 6 | 2:40–3:25 | Incident room | Point at the rippling epicenter and the scorecard. Scroll to **Automated analysis**: *Why this epicenter*, *Suggested checks*, *Similar past incidents* with your note. Click **Copy report**. | "It explains its answer: the database depends on nothing that is alerting, and every other alerting service calls it. It suggests what to check, finds the similar incident from earlier with what we did then, and drafts the postmortem. All rule-based, from the dependency graph, no AI model." | originality, historical analysis |
| 7 | 3:25–3:55 | Incident room → Pipeline | Press **Replay**, pick **16×**, play, drag the scrubber, then **Go Live**. Then Chaos Lab: start *Duplicate storm*; on Pipeline, show *Dupes* climbing. | "Every incident is a recording: sixteen times speed, scrub to the moment it started, back to live. And every batch is now sent three times, shuffled: duplicates climb, the charts do not flinch." | history + live, dedup |
| 8 | 3:55–4:25 | `docs/BENCHMARKS.md` on GitHub | Scroll the summary table, then *A bottleneck found and fixed* and *Where it breaks*. | "Measured on one laptop: ten thousand events a second to two hundred dashboards with no refusals and 27 milliseconds delivery; at fifty thousand, load shedding kicks in and recovers. The stress test found a write bottleneck at four thousand nodes; we fixed it. And we say where it breaks: twenty thousand nodes runs out of memory." | performance measurements |
| 9 | 4:25–4:40 | `docs/ARCHITECTURE.md` diagram, then <https://epicenter-one.vercel.app> | Show the system diagram, then the hosted site signed in. | "MongoDB, Express, React, Node and Socket.IO, hosted on Vercel, Render and Atlas. The code, the architecture and the benchmarks are linked from the README." | hosting, documentation |

**If something misbehaves while recording**
- The incident takes long to appear: a recent *Slow database* run is still in the detector's baseline. Wait
  five minutes and re-take shot 5.
- No desktop notification: check the Display menu says *On* and the browser has notification permission for
  the site; the in-page toast appears either way, so the shot still works.
- *Similar past incidents* is empty: the earlier practice incident did not resolve yet (it needs 30 s with
  no firing alert) or it was in a different scope. The panel still shows the evidence and checks.

## After recording

- Cut to under 5:00. Add captions for the numbers (events/s, latency) if they are hard to read.
- Upload as **unlisted** (YouTube or Drive with link sharing), then put the link in the README's table at the
  top (the *Demo video* row).
- Watch it once on a phone: the judges might.
