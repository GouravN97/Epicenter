# Learn telemetry with Epicenter: a hands-on walkthrough

This guide is for someone who has never done SRE work or looked at a monitoring dashboard. You will run
Epicenter, break a pretend company's servers on purpose, and watch how telemetry tells you what went wrong.
It takes about 30 minutes. No prior knowledge is needed beyond running two commands in a terminal.

By the end you should be able to answer, in your own words:

- What is telemetry, and where does it come from?
- What do CPU, latency, error rate and p95 mean, and what does "bad" look like?
- What is the difference between a metric, an alert and an incident?
- Why does one broken service make many others look broken, and how do you find the real cause?

> Looking for the script for recording the submission video? That is a different file: [`docs/DEMO.md`](docs/DEMO.md).

---

## 1. The idea in two minutes

**Telemetry** is the stream of measurements a running system sends out about itself. A server cannot tell
you "I am struggling", but it can report, twice a second, "my CPU is at 91 %, my requests take 400 ms, and
3 % of them fail". Collect those reports from every server, and you can see the health of a whole company's
systems from one screen.

**SRE** (site reliability engineering) is the job of keeping those systems working. An SRE's daily loop is:

1. **Observe**: watch the telemetry.
2. **Detect**: notice when something is abnormal.
3. **Diagnose**: work out the cause, not just the symptoms.
4. **Learn**: look back at what happened so it is caught faster next time.

Epicenter has one screen for each step, and this guide walks through them in that order.

### What you are monitoring

Epicenter watches a pretend online shop called **ShopStream**. It is simulated, but it behaves like a real
one:

- **48 nodes.** A *node* is one server (one machine).
- **9 services.** A *service* is one program doing one job, such as "check the password" or "store the
  order". Each service runs on several nodes so that one machine failing does not stop it.
- **3 regions.** The nodes are spread over three parts of the world.

The services call each other. A customer's request arrives at the top and works its way down:

```
                 Edge Gateway            <- every customer request enters here
                /      |       \
            Auth   Catalog API   Orders API
            /  \     /   \       /   |    \
        Cache  DB  Cache  DB   DB  Queue  Payments
                                     |
                                   Worker --> DB
```

Read a line as "needs". The Edge Gateway needs Auth; Auth needs the Cache and the Database (DB). This is
called a **dependency graph**, and it matters a great deal: if the Database gets slow, everything above it
that needs the Database gets slow too. Remember this picture. Section 6 is built on it.

### The eight numbers every node reports

| Metric | Unit | Plain meaning | Worry when |
|---|---|---|---|
| CPU | % | How busy the processor is | It stays above about 80 % |
| Memory | % | How much working memory is in use | It climbs steadily and never comes down (a "leak") |
| Disk | % | How full the storage is | It nears 100 % |
| Network in / out | kB/s | Data arriving at and leaving the node | It jumps or drops to zero suddenly |
| Latency | ms | How long one request takes to answer | It rises well above the service's normal |
| Error rate | % | Share of requests that fail | It is above a percent or two |
| Requests per second (rps) | req/s | How much work is arriving | It changes sharply either way |

Two words you will see next to these numbers:

- **p95** ("95th percentile"). "Latency p95 = 120 ms" means 95 % of requests were faster than 120 ms and the
  slowest 5 % were slower. It is used instead of the average because an average hides the unlucky customers.
  p50 is the middle request; p99 is nearly the worst.
- **SLO** ("service level objective"). The target a service promises to meet, such as "the Database answers
  within 20 ms". Latency is judged against the SLO, not against a universal number: 80 ms is terrible for the
  Cache and perfectly fine for Payments.

---

## 2. Start the app

The simplest way needs no database. From the repository root:

```bash
npm install
npm run dev:mock -w @epicenter/client
```

Open <http://localhost:5173>. On the sign-in page click the **Admin** quick-fill button, type any password,
and sign in.

This is *mock mode*: the whole fleet is simulated inside your browser. Everything in this guide works in it.
Two things to know:

- The badge in the toolbar says **Mock data** instead of **Live**.
- Mock mode breaks something by itself every four minutes so the dashboard is never boring. If an alert or
  incident appears that you did not cause, that is why. It pauses while a fault you started is running.

> **Prefer to be led through it?** The app has this walkthrough built in. The first time an account signs
> in, a guided tour opens in the corner, points at each part of the screen, and checks off each exercise as
> you do it. Restart it any time with the **Tour** button in the toolbar. This page is the same material in
> more depth, with a glossary.

> **Keyboard:** press **?** anywhere in the app for the list of shortcut keys. In the tour, **N** is next and
> **B** is back. The full list is in [Keyboard shortcuts](#keyboard-shortcuts) below.

To run the real stack instead (server, MongoDB and the simulator as separate programs), follow *Setup and
running* in the [README](README.md), then use `npm run seed`, `npm run dev` and `npm run sim`.

---

## 3. Observe: the Overview page

You land on **Overview**. This is the "is everything fine?" screen.

### The four tiles at the top

| Tile | What it tells you |
|---|---|
| **Nodes healthy** | How many of the 48 servers are fine right now |
| **Ingress traffic** | Requests per second arriving at the Edge Gateway, i.e. how busy the shop is |
| **Gateway latency p95** | How long customers are waiting, measured where they enter |
| **Open incidents** | How many problems are currently being tracked |

The small line inside a tile is a **sparkline**: the last minute of that number, so you can see whether it is
rising or falling, not only where it is.

**Try it:** watch *Ingress traffic* for 20 seconds. It wobbles. Telemetry is never a flat line; learning what
normal wobble looks like is the first SRE skill.

### The Fleet panel

Each hexagon is one node, grouped by service.

- **Fill colour is CPU**, in five steps from 0–20 % to 80–100 %. The scale is under the hexagons.
- **Outline and centre mark are status.** There are four:

| Status | Meaning |
|---|---|
| **Healthy** | Nothing unusual |
| **Warning** | Something is abnormal; worth a look |
| **Critical** | Seriously abnormal; customers are probably affected |
| **Silent** | The node has stopped reporting altogether |

**Try it:**

1. Hover a hexagon. A card shows the node's name, service, CPU and memory. (By keyboard: **F** focuses the
   heatmap, the arrow keys move between nodes, **Enter** opens one.)
2. Read a node name, for example `us-east-1a.db.02`: where it runs (region and zone), its service, its number.
3. Count how many hexagons the Worker service has compared with Auth. Busier services get more nodes.

> **Why Silent is its own status.** A node that reports "CPU 100 %" is in trouble but alive. A node that
> reports nothing might be powered off, crashed or cut off from the network. Missing telemetry is itself a
> signal. The check for it is called a **heartbeat**: if a node says nothing for 5 seconds, it is marked Silent.

### The Alerts panel

On the right is the alert feed, with **Active** and **All** tabs. It may be empty; that is good news. You
will fill it in section 5. Under the tabs, a menu narrows the feed to one metric (CPU, Memory, Latency,
Errors or Network in), and **Export JSON** (key **E**) saves the alerts shown as a `.json` file.

---

## 4. Observe closely: one node

Click any hexagon. You are now on that node's detail page, with four charts that share one time axis:

| Chart | Lines | What to look for |
|---|---|---|
| **CPU and memory** | CPU, Memory | CPU that pins high; memory that only goes up |
| **Latency** | Latency | Sudden steps upward |
| **Errors** | Error rate | Anything lifting off zero |
| **Network** | In, Out | Sharp jumps or drops |

**Try it:**

1. Move the mouse across one chart. The cursor moves on all four. This is the point of putting them on one
   axis: you can ask "when latency rose, what else changed at that moment?"
2. Switch the range between **5 m**, **15 m**, **1 h** and **6 h** (keys **1** to **4**). Short ranges show detail; long ranges
   show trends. (In a freshly started app the long ranges are mostly empty, because nothing has been recorded
   yet.)
3. Press **Compare with 1 h ago** (key **C**). A dashed line shows the same metric an hour earlier. This is a
   **baseline**: the quickest way to answer "is this normal for this node?"

### Choose what you look at, and take it with you

Above the charts is a row of **Metrics** chips, one per metric a node reports. Click a chip to show or hide
that metric. Disk and Requests are hidden at first; turn them on to see all eight. Your choice is remembered.

**Export JSON** (key **E**) saves exactly what the charts show, the selected metrics over the selected
range, as a `.json` file: one row per point with its time and one field per metric. This is how telemetry
leaves a dashboard for a spreadsheet, a notebook or a postmortem document.

**Try it:** turn on **Disk**, turn off **Memory**, press **E**, and open the downloaded file in a text editor.

### Live data and history are one line

The right-hand edge of each chart is *now* and it keeps moving: new points arrive every second. Everything to
the left was loaded from stored history. A good monitoring tool joins the two without a gap or a doubled
point, even if your connection drops.

**Try it:** open the browser's developer console (F12, *Console* tab) and run:

```js
epicenter.drop(15000)
```

This cuts the live connection for 15 seconds. The toolbar badge goes to **Offline**, then **Reconnecting**,
then back. Watch the chart: when the connection returns, the missing 15 seconds are filled in from history.

---

## 5. Detect: metrics become alerts

Nobody can watch 48 nodes times 8 metrics all day. **Alerts** are how the system watches for you: rules run
on the telemetry and raise a flag when something is wrong. Epicenter uses four kinds of rule, and each one
catches a different kind of problem:

| Rule | Plain meaning | Catches |
|---|---|---|
| **Threshold** | "Latency is more than three times this service's SLO" | Things that are plainly too high |
| **Anomaly (z-score)** | "This value is far outside what is normal *for this node*" | Sudden changes, even at values that would be fine elsewhere |
| **Heartbeat** | "This node has said nothing for 5 seconds" | Dead or disconnected machines |
| **Predictive** | "Memory is climbing steadily and will run out within about 5 minutes" | Slow problems, before they hurt |

An alert has a severity (**Warning** or **Critical**) and a state: **Firing** (happening now), **Acknowledged**
(a person has said "I am on it") or **Resolved** (the metric went back to normal).

Now cause one. Open **Chaos Lab** in the navigation (it is only shown to the Admin account).

> **What is chaos engineering?** Breaking things on purpose, in a controlled way, to check that your
> monitoring notices and your system copes. Here it is also the best way to learn, because you know the
> right answer before the dashboard tells you.

### Exercise A: a busy node

1. Under **Node faults**, find **CPU spike**. Pick any target node, and press **Start**.
2. Click **Watch the node**.
3. On the CPU chart, the line jumps by about 60 points. Within a few seconds an alert appears under
   **Alert history** at the bottom of the page.
4. Go to **Overview**. One hexagon has a darker fill and a Warning or Critical outline, and the alert is in
   the feed. Press **Ack** on it; its state changes to *Acknowledged*.
5. Wait for the run to end (60 seconds). CPU falls back and the alert becomes **Resolved** by itself.

What you just saw is the whole detect loop: a metric moved, a rule noticed, a person was told, the metric
recovered.

### Exercise B: a dead node

1. In Chaos Lab, start **Kill node** on any node.
2. Go to **Overview**. After 5 to 8 seconds one hexagon turns **Silent**, and a heartbeat alert fires.
3. Open that node. Its charts have simply stopped. There is no "bad" value to see, only an absence.

### Exercise C (optional): a slow problem

Start **Memory leak** and watch that node's memory line climb slowly. The **Predictive** alert fires while
the value is still acceptable, because the rule is looking at where the line is heading, not where it is.

---

## 6. Diagnose: one cause, many symptoms

This is the part that makes real incidents hard, and the reason Epicenter exists.

Look again at the dependency graph in section 1 and predict: **if the Database becomes slow, which services
will look unhealthy?**

Auth, Catalog API, Orders API and Worker all call the Database, so they slow down. The Edge Gateway calls
Auth, Catalog and Orders, so it slows down as well. That is six services showing alerts, and only one of them
is actually broken. The other five are **symptoms**. The set of services a failure can spread to is called its
**blast radius**. Finding the one real cause is called **root cause analysis**.

### Exercise D: slow the database

1. In Chaos Lab, under **Service faults**, start **Slow database** (target **Database**).
2. Click **Watch the topology**.

The **Topology** page draws the dependency graph live. Each box is a service, showing its traffic and its
p95 latency against its SLO. The lines are the calls between services.

Watch what happens over the next 20 to 30 seconds:

- The Database's latency climbs far past its SLO.
- Then the services above it turn Warning or Critical, one layer at a time, moving *up* the graph.
- Epicenter notices that these alerts are connected, groups them into **one incident**, and marks the
  Database as the **epicenter**: the place the failure started. It ripples on the map.

The **Incident** panel on the right now shows:

| Field | Meaning |
|---|---|
| **Epicenter** | The service Epicenter believes is the root cause |
| **Confidence** | How sure it is |
| **Alerting** | Services that currently have alerts |
| **Blast radius** | Services that depend on the epicenter and so can be affected |

So the three words are a ladder:

- A **metric** is one number over time. ("Database latency.")
- An **alert** is one rule saying one metric on one node is abnormal. ("Latency on `us-east-1a.db.02` is 8× normal.")
- An **incident** is a group of related alerts with one cause. ("The Database is slow, and that is why five
  other services are too.")

Without the grouping you would have a feed of fifteen alerts and no idea where to start. With it, you have
one thing to fix.

**How does it know?** It uses the graph. If a service and the services it depends on are all alerting, the
problem is most likely in the deepest one, because failures travel upward from callee to caller, never
downward. Check that yourself on the map: the Queue and the Cache stay healthy throughout, because neither of
them calls the Database.

**Try it again with a different cause:** start **Cache outage**. Before looking, predict the blast radius
from the graph (Auth, Catalog API, and the Edge Gateway above them). Then check the map.

---

## 7. Learn: the incident room and replay

Go to **Incidents**. Each row is one incident, with **Open** and **All** tabs. Open the one you just caused.

The incident room collects everything about one problem:

- The header: the epicenter, the confidence, how long it has been open or how long it lasted.
- **Topology**: the same map, limited to this incident.
- **Timeline**: every alert and note in order. SREs write notes here as they investigate.
- A chart of the epicenter service, and the **Nodes involved**.
- **Chaos scorecard** (because you caused this one from the Chaos Lab): the *time to detect* and whether the
  detected epicenter matched what was really broken.

### Replay it

Real incidents are fast and stressful, and most of the learning happens afterwards. That review is called a
**postmortem**, and it depends on being able to see what happened in order.

1. Press **Replay** (key **P**, which also plays and pauses). The toolbar badge changes to **Replay**: every chart and map on this page now shows
   recorded data, not live data.
2. Choose **16×** (key **3**) and watch the failure spread up the graph again, in fast forward.
3. Drag the scrubber back to just before the first alert marker. Everything is healthy. Step forward and
   find the moment the Database's latency leaves normal. That is the true start, usually a few seconds
   before the first alert.
4. Press **Go Live** (key **L**) to return to the present. (Only shown while the incident is still open.)

The gap between "the metric first went wrong" and "the alert fired" is the **time to detect**. Shortening it,
without creating false alarms, is one of the main things SREs work on.

---

## 8. Where telemetry comes from: the Pipeline page

So far you have used telemetry. The **Pipeline** page ("Pipeline X-ray") shows how it reaches your screen.
The monitoring system is itself a system that can be overloaded, so it reports on itself too.

Follow one measurement from left to right through the six stages:

| # | Stage | What happens | Why |
|---|---|---|---|
| 1 | **Ingest** | The server receives batches of readings and checks each is well formed. Bad ones are rejected; excessive traffic is refused with "429, slow down". | One broken or noisy sender must not take down monitoring for everyone |
| 2 | **Dedup** | Readings that arrive twice are dropped | Networks retry, so the same reading often arrives more than once; counting it twice would distort the charts |
| 3 | **Aggregate** | Readings are grouped into one point per node per second | Charts need one tidy value per second, not a pile of raw readings |
| 4 | **Write** | Points are saved to the database in batches | This is the history you saw on the node charts and in replay |
| 5 | **Broadcast** | Only what changed is pushed to the browsers that are looking at it | Sending everything to everyone every second would not scale |
| 6 | **This browser** | Your screen draws it, and measures how old the data is | So you know how far behind reality you are |

Look at **data delay** in stage 6 (also shown beside the toolbar badge). It is around 3 seconds, and that is
deliberate: the server waits a moment for late readings before it calls a second "finished". All telemetry is
slightly in the past. Knowing how far is part of reading it correctly.

### Exercise E: attack the pipeline

1. In Chaos Lab, under **Pipeline stress**, start **Duplicate storm**. Every batch of readings is now sent
   three times, in shuffled order.
2. Click **Watch the pipeline**. In stage 2, **Duplicates dropped** climbs. The *Filtered out per second*
   chart shows the same.
3. Open **Overview** or any node. Nothing looks different. That is the result you want: the pipeline absorbed
   the mess before it reached a chart.
4. Try **Malformed flood** and watch **Rejected (invalid)** and **Refused with 429** in stage 1 instead.

---

## 9. One more thing: who sees what

Sign out and sign in with the **Viewer** quick-fill (`payments@epicenter.dev`). This account belongs to the
payments team only. The Overview now shows just the Payments nodes, the Chaos Lab is gone from the
navigation, and other teams' alerts never appear.

In a real company, telemetry can reveal sensitive things (traffic volumes, outages, internal names), so
access is scoped by team and by role:

| Role | Can do |
|---|---|
| **Admin** | See everything and run the Chaos Lab |
| **SRE** | See everything, acknowledge alerts, write incident notes |
| **Viewer** | See only their own team's nodes, alerts and incidents |

---

## 10. Check yourself

Try to answer before opening each one.

<details><summary>A node's hexagon is Silent. Is its CPU high or low?</summary>

You cannot know. Silent means no telemetry is arriving, so there is no CPU value at all. The node may be
off, crashed or unreachable.
</details>

<details><summary>Six services are alerting on latency. Where do you look first?</summary>

At the one deepest in the dependency graph, the one the others call. Failures travel up from a dependency to
its callers. On the Topology page this is the service marked as the epicenter.
</details>

<details><summary>Payments has 80 ms latency and the Cache has 80 ms latency. Which is in trouble?</summary>

The Cache. Its SLO is 5 ms, so 80 ms is sixteen times too slow. Payments' SLO is 300 ms, so 80 ms is healthy.
Latency only means something next to the target for that service.
</details>

<details><summary>Why report p95 latency and not the average?</summary>

The average hides slow requests behind many fast ones. p95 tells you what the slowest one in twenty customers
experiences, which is where problems show first.
</details>

<details><summary>What is the difference between an alert and an incident?</summary>

An alert is one rule firing for one metric on one node. An incident is a group of related alerts that share a
cause, with a named epicenter and blast radius.
</details>

<details><summary>During the duplicate storm, the charts did not change. Was the test a failure?</summary>

No, it was a pass. The duplicates were counted and dropped in the Dedup stage, which is visible on the
Pipeline page. The dashboards staying steady is the proof that it worked.
</details>

---

## Keyboard shortcuts

Press **?** in the app to see this list at any time. Shortcuts are single keys, and they pause while you are
typing in a field. "g o" means press **G**, then **O**.

| Where | Key | What it does |
|---|---|---|
| Anywhere | `?` | Show or hide the shortcut list |
| Anywhere | `g o` | Go to Overview |
| Anywhere | `g t` | Go to Topology |
| Anywhere | `g i` | Go to Incidents |
| Anywhere | `g c` | Go to Chaos Lab (Admin only) |
| Anywhere | `g p` | Go to Pipeline |
| Anywhere | `d` | Switch display mode (Control room / Glass) |
| Anywhere | `t` | Start, hide or resume the guided tour |
| Guided tour | `n` | Next step, or skip the exercise |
| Guided tour | `b` | Previous step |
| Overview | `f` | Focus the fleet heatmap; then arrow keys to move, Enter to open a node |
| Overview | `a` | Switch the alert feed between Active and All |
| Overview | `i` | Open the incident shown in the banner |
| Overview | `e` | Export the alerts shown as a `.json` file |
| Node page | `1` to `4` | Time range: 5 m, 15 m, 1 h, 6 h |
| Node page | `c` | Compare with 1 h ago |
| Node page | `e` | Export the selected metrics as a `.json` file |
| Incidents list | `a` | Switch the list between Open and All |
| Incident room | `p` | Replay, play or pause |
| Incident room | `s` | Back to the start of the recording |
| Incident room | `1` to `3` | Playback speed: 1×, 4×, 16× |
| Incident room | `l` | Go live |

Starting and stopping faults, acknowledging alerts and signing out have no shortcut on purpose: one stray key
should not break the fleet or change an alert's state.

## Glossary

| Term | Meaning |
|---|---|
| **Telemetry** | Measurements a system sends out about itself, continuously |
| **Metric** | One measured number tracked over time, such as CPU |
| **Node** | One server |
| **Service** | One program doing one job, usually running on several nodes |
| **Fleet** | All the nodes together |
| **Region** | A geographic location where nodes run |
| **Latency** | Time taken to answer one request |
| **Error rate** | Share of requests that fail |
| **rps** | Requests per second |
| **p50 / p95 / p99** | The value that 50 %, 95 % or 99 % of requests are better than |
| **SLO** | The performance target a service is expected to meet |
| **Baseline** | What normal looks like, used for comparison |
| **Anomaly** | A value far from that node's normal |
| **Heartbeat** | The check that a node is still reporting |
| **Alert** | A rule flagging that one metric on one node is abnormal |
| **Incident** | A group of related alerts with one cause |
| **Dependency graph / topology** | The map of which services call which |
| **Root cause** | The one thing actually broken |
| **Epicenter** | This app's name for the service identified as the root cause |
| **Blast radius** | Everything a failure can spread to |
| **Time to detect** | Delay between a fault starting and the system noticing |
| **Postmortem** | The review after an incident, to learn from it |
| **Chaos engineering** | Breaking things deliberately to test detection and resilience |
| **Ingest** | Receiving telemetry into the monitoring system |
| **Deduplication** | Dropping readings that arrived more than once |
| **Aggregation** | Combining raw readings into one point per second |
| **Load shedding** | Refusing some traffic on purpose so the system stays up |

## Where to go next

- [`README.md`](README.md): features, setup for the real stack, and how ingestion and live delivery work.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the design in detail, with diagrams.
