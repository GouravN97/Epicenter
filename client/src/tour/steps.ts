// The guided tour: the walkthrough in demo.md, as steps the app leads a new user through after sign-in.
// This file is data and pure functions only (no React, no stores), so the step logic can be unit tested.
// TourGuide.tsx renders a step, builds the TourCtx from the live stores, and does the navigation.
import type { AlertDTO, ChaosActiveRun, ChaosScenarioId, IncidentDTO, Role } from '@epicenter/shared';

/** What a step may look at to decide where it happens and whether its exercise is done. */
export interface TourCtx {
  pathname: string;
  role: Role;
  /** Mock mode: a background fault runs by itself every four minutes. */
  mock: boolean;
  /** A node the user may open, for steps that need a node page. */
  firstNodeId: string | null;
  /** Newest first. */
  alerts: readonly AlertDTO[];
  /** Newest first. */
  incidents: readonly IncidentDTO[];
  chaosActive: readonly ChaosActiveRun[];
  /** Recent chaos runs, newest first. */
  chaosHistory: readonly { scenario: ChaosScenarioId; target: string | null; startedAt: number }[];
  /** The incident room is showing a recording. */
  replaying: boolean;
  /** "Compare with 1 h ago" is switched on. */
  comparing: boolean;
}

export interface TourTask {
  /** The instruction, in the imperative. */
  label: string;
  done: (ctx: TourCtx) => boolean;
}

export interface TourStep {
  id: string;
  /** The part of the SRE loop this step belongs to. */
  chapter: string;
  title: string;
  /** Paragraphs. `**text**` is emphasised. */
  body: string[];
  /** Term and meaning pairs, shown as a short list under the body. */
  points?: [term: string, meaning: string][];
  /** Self-check questions; the answer is hidden until opened. */
  quiz?: { q: string; a: string }[];
  /** Shown only to these roles. Default: everyone. */
  roles?: Role[];
  /** The page this step happens on. Null when it cannot be worked out yet. */
  route?: (ctx: TourCtx) => string | null;
  /** Whether a path counts as being on that page. Default: the path equals `route`. */
  at?: (pathname: string) => boolean;
  /** Name of the page, for "This step is on …". */
  place?: string;
  /** `data-tour` anchor to highlight. */
  target?: string;
  /** Dock the card on the left, for targets on the right-hand side of the page. */
  side?: 'left';
  /** A hands-on exercise. It never blocks Next; when it completes, the tour moves on by itself. */
  task?: TourTask;
  /** An extra button on the card. `drop`: cut the live connection for a few seconds. */
  action?: 'drop';
  /** A warning to show under the task, or null. */
  caution?: (ctx: TourCtx) => string | null;
}

// ---------------------------------------------------------------- helpers

const ADMIN: Role[] = ['admin'];
const NOT_ADMIN: Role[] = ['sre', 'viewer'];

const onNode = (p: string) => p.startsWith('/node/');
const onIncidents = (p: string) => p === '/incidents' || p.startsWith('/incidents/');

/** The newest run of a scenario, running or finished. `startedAt` is 0 when only the active list knows it. */
export function lastRun(ctx: TourCtx, scenario: ChaosScenarioId): { target: string | null; startedAt: number } | null {
  const past = ctx.chaosHistory.find((r) => r.scenario === scenario);
  if (past) return { target: past.target, startedAt: past.startedAt };
  const now = ctx.chaosActive.find((r) => r.scenario === scenario);
  return now ? { target: now.target, startedAt: 0 } : null;
}

const running = (ctx: TourCtx, scenario: ChaosScenarioId) => ctx.chaosActive.some((r) => r.scenario === scenario);

/** Alerts need a moment of evidence, and clocks differ slightly: accept ones from just before the run. */
const SLACK_MS = 3000;

const startTask = (scenario: ChaosScenarioId, name: string): TourTask => ({
  label: `Press Start on the ${name} card.`,
  done: (ctx) => running(ctx, scenario),
});

const othersRunning = (scenario: ChaosScenarioId) => (ctx: TourCtx) =>
  ctx.chaosActive.some((r) => r.scenario !== scenario)
    ? 'Another fault is still running. Stop it under "Running now" first, so the result is easy to read.'
    : null;

/**
 * The incident the tour is about. A cascade can open more than one (a late alert may start a small second
 * incident), so of those the slow-database run caused, take the one that names the run's target as its
 * epicenter, else the widest. With no run to go by (not an admin), the newest with an epicenter.
 */
export function tourIncident(ctx: TourCtx): IncidentDTO | null {
  const run = lastRun(ctx, 'slow-db');
  if (run) {
    const caused = ctx.incidents.filter((i) => i.startedAt >= run.startedAt - SLACK_MS && i.epicenter);
    const best = caused.find((i) => i.epicenter === run.target) ?? [...caused].sort((x, y) => y.affected.length - x.affected.length)[0];
    if (best) return best;
  }
  return ctx.incidents.find((i) => i.epicenter) ?? ctx.incidents[0] ?? null;
}

// ---------------------------------------------------------------- the steps

export const TOUR_STEPS: readonly TourStep[] = [
  // ------------------------------------------------------------ Start
  {
    id: 'welcome',
    chapter: 'Start',
    title: 'What is telemetry?',
    body: [
      'A server cannot tell you it is struggling. It can only report numbers: "my CPU is at 91 %, my requests take 400 ms, 3 % of them fail". **Telemetry** is that stream of measurements, sent continuously by every server.',
      'Keeping systems working from those numbers is the job of an **SRE** (site reliability engineer). The work is a loop, and this tour follows it:',
    ],
    points: [
      ['Observe', 'watch the telemetry'],
      ['Detect', 'notice when something is abnormal'],
      ['Diagnose', 'find the cause, not just the symptoms'],
      ['Learn', 'look back so it is caught faster next time'],
    ],
  },
  {
    id: 'shopstream',
    chapter: 'Start',
    title: 'What you are monitoring',
    route: () => '/',
    place: 'Overview',
    body: [
      'This app watches a pretend online shop, **ShopStream**. It is simulated, but it behaves like a real one. You will break parts of it on purpose and watch how the telemetry shows what went wrong.',
    ],
    points: [
      ['Keyboard', 'N is next and B is back in this tour. Press ? any time for every shortcut key.'],
      ['Node', 'one server. There are 48.'],
      ['Service', 'one program doing one job, such as Auth or Database. There are 9, each running on several nodes.'],
      ['Region', 'a part of the world where nodes run. There are 3.'],
    ],
  },

  // ------------------------------------------------------------ Observe
  {
    id: 'tiles',
    chapter: 'Observe',
    title: 'Is everything fine?',
    route: () => '/',
    place: 'Overview',
    target: 'tiles',
    body: [
      'These four tiles answer that at a glance: how many nodes are healthy, how much traffic is arriving, how long customers wait, and how many problems are open.',
      'The small line in a tile is the last minute of that number. Watch it wobble: telemetry is never a flat line, and knowing what normal wobble looks like is the first skill.',
    ],
    points: [
      ['Latency', 'how long one request takes to answer.'],
      ['p95', '95 % of requests were faster than this. Used instead of the average, which hides the unlucky customers.'],
    ],
  },
  {
    id: 'fleet',
    chapter: 'Observe',
    title: 'Every server on one screen',
    route: () => '/',
    place: 'Overview',
    target: 'fleet',
    body: [
      'Each hexagon is one node, grouped by service. The **fill** is how busy its CPU is. The **outline and centre mark** are its status: Healthy, Warning, Critical or Silent.',
      '**Silent** means the node has stopped reporting. That is different from reporting something bad: missing telemetry is a signal of its own.',
    ],
    task: { label: 'Hover a few hexagons, then click one to open that node.', done: (ctx) => onNode(ctx.pathname) },
  },
  {
    id: 'node-charts',
    chapter: 'Observe',
    title: 'One node, up close',
    route: (ctx) => (ctx.firstNodeId ? `/node/${encodeURIComponent(ctx.firstNodeId)}` : null),
    at: onNode,
    place: 'a node page',
    target: 'node-charts',
    body: [
      'Four charts of the same node: CPU and memory, latency, errors, network. The right edge is now, and a new point arrives every second.',
      'Move the pointer across one chart and the cursor moves on all four. That lets you ask the key question: **when this went wrong, what else changed at the same moment?**',
    ],
    points: [
      ['Error rate', 'the share of requests that fail. Healthy is close to zero.'],
      ['Memory', 'worry when it only ever climbs. That is a leak.'],
    ],
  },
  {
    id: 'node-baseline',
    chapter: 'Observe',
    title: 'Is this normal?',
    route: (ctx) => (ctx.firstNodeId ? `/node/${encodeURIComponent(ctx.firstNodeId)}` : null),
    at: onNode,
    place: 'a node page',
    target: 'node-controls',
    body: [
      'A number means little alone. 60 % CPU is calm for one node and alarming for another. You judge it against a **baseline**: what this node usually does.',
      'The range buttons trade detail (5 m) for trend (6 h). On a freshly started app the long ranges are mostly empty, because nothing has been recorded yet.',
    ],
    task: { label: 'Press "Compare with 1 h ago". A dashed line shows the same metric an hour earlier.', done: (ctx) => ctx.comparing },
  },
  {
    id: 'node-live',
    chapter: 'Observe',
    title: 'History and live are one line',
    route: (ctx) => (ctx.firstNodeId ? `/node/${encodeURIComponent(ctx.firstNodeId)}` : null),
    at: onNode,
    place: 'a node page',
    target: 'node-charts',
    action: 'drop',
    body: [
      'The left of each chart was loaded from stored history; the right edge is streaming live. A good monitoring tool joins them with no gap and no doubled point, even when your connection fails.',
      'Try it: cut the connection below. The badge in the toolbar goes Offline, then returns, and the chart fills in the seconds it missed.',
    ],
  },

  // ------------------------------------------------------------ Detect
  {
    id: 'alerts',
    chapter: 'Detect',
    title: 'Nobody can watch 48 nodes',
    route: () => '/',
    place: 'Overview',
    target: 'alerts',
    side: 'left',
    body: [
      'So rules watch for you. When a rule finds something wrong it raises an **alert**, and alerts land in this feed. An alert is Firing, then Acknowledged ("someone is on it"), then Resolved. Four kinds of rule each catch a different problem:',
    ],
    points: [
      ['Threshold', 'plainly too high, such as latency over three times the target.'],
      ['Anomaly', 'far from what is normal for this node.'],
      ['Heartbeat', 'the node has said nothing for 5 seconds.'],
      ['Predictive', 'memory is climbing and will run out within minutes.'],
    ],
  },
  {
    id: 'cpu-start',
    chapter: 'Detect',
    title: 'Break something on purpose',
    roles: ADMIN,
    route: () => '/chaos',
    place: 'Chaos Lab',
    target: 'chaos-cpu-spike',
    body: [
      'This is the **Chaos Lab**. Breaking things deliberately, to check that monitoring notices, is called chaos engineering. It is also the best way to learn, because you know the right answer before the dashboard tells you.',
      'Start small: make one node very busy.',
    ],
    task: startTask('cpu-spike', 'CPU spike'),
    caution: othersRunning('cpu-spike'),
  },
  {
    id: 'cpu-watch',
    chapter: 'Detect',
    title: 'A metric becomes an alert',
    roles: ADMIN,
    route: (ctx) => {
      const node = lastRun(ctx, 'cpu-spike')?.target;
      return node ? `/node/${encodeURIComponent(node)}` : null;
    },
    at: onNode,
    place: 'the node you spiked',
    target: 'node-alerts',
    body: [
      'This is the node you just spiked. Its CPU line has jumped by about 60 points. Within a few seconds a rule notices and an alert appears in **Alert history** below.',
      'When the run ends, CPU falls back and the alert resolves by itself. That is the whole detect loop: a metric moved, a rule noticed, a person was told, the metric recovered.',
    ],
    task: {
      label: 'Wait for the alert to appear.',
      done: (ctx) => {
        const run = lastRun(ctx, 'cpu-spike');
        return !!run && ctx.alerts.some((a) => a.nodeId === run.target && a.startedAt >= run.startedAt - SLACK_MS);
      },
    },
  },
  {
    id: 'kill-start',
    chapter: 'Detect',
    title: 'Now switch one off',
    roles: ADMIN,
    route: () => '/chaos',
    place: 'Chaos Lab',
    target: 'chaos-node-kill',
    body: [
      'A busy node still reports. A dead one says nothing at all, so there is no bad value for a threshold to catch. This is what the **heartbeat** rule is for.',
    ],
    task: startTask('node-kill', 'Kill node'),
  },
  {
    id: 'kill-watch',
    chapter: 'Detect',
    title: 'Silence is a signal',
    roles: ADMIN,
    route: () => '/',
    place: 'Overview',
    target: 'fleet',
    body: [
      'Watch the fleet. After 5 to 8 seconds one hexagon turns **Silent** and a heartbeat alert fires. Open that node afterwards if you like: its charts have simply stopped.',
      'Optional, later: the **Memory leak** scenario shows the predictive rule firing while memory is still at an acceptable level, because it looks at where the line is heading.',
    ],
    task: {
      label: 'Wait for the heartbeat alert.',
      done: (ctx) => {
        const run = lastRun(ctx, 'node-kill');
        return !!run && ctx.alerts.some((a) => a.rule === 'heartbeat' && a.nodeId === run.target && a.startedAt >= run.startedAt - SLACK_MS);
      },
    },
  },
  {
    id: 'alert-wait',
    chapter: 'Detect',
    title: 'See one fire',
    roles: NOT_ADMIN,
    route: () => '/',
    place: 'Overview',
    target: 'alerts',
    side: 'left',
    body: [
      'Admins can cause faults on purpose from the Chaos Lab. Your account cannot, so you see alerts when something goes wrong by itself or an admin starts a fault.',
      'In mock mode a fault starts by itself every four minutes. When an alert arrives, its node also changes outline in the fleet.',
    ],
    task: { label: 'Wait for an alert, or press Next to carry on.', done: (ctx) => ctx.alerts.some((a) => a.state !== 'resolved') },
  },

  // ------------------------------------------------------------ Diagnose
  {
    id: 'graph',
    chapter: 'Diagnose',
    title: 'Services need each other',
    route: () => '/topology',
    place: 'Topology',
    target: 'topo-map',
    body: [
      'This map is the **dependency graph**. Each box is a service; a line means "needs". The Edge Gateway at the top needs Auth, Catalog and Orders, and they need the Cache, Database and Queue below.',
      'Each box shows live traffic and p95 latency against the service\'s target (its **SLO**). 80 ms is terrible for the Cache and fine for Payments, which is why latency is judged per service.',
      '**Predict before you continue:** if the Database became slow, which services would look unhealthy?',
    ],
  },
  {
    id: 'slowdb-start',
    chapter: 'Diagnose',
    title: 'Slow the database',
    roles: ADMIN,
    route: () => '/chaos',
    place: 'Chaos Lab',
    target: 'chaos-slow-db',
    body: [
      'Test your prediction. This makes the Database answer eight times slower than normal. Every service that calls it will slow down too, and so will everything that calls those.',
    ],
    task: startTask('slow-db', 'Slow database'),
    caution: othersRunning('slow-db'),
  },
  {
    id: 'incident',
    chapter: 'Diagnose',
    title: 'One cause, many symptoms',
    route: () => '/topology',
    place: 'Topology',
    target: 'topo-incident',
    side: 'left',
    body: [
      'Watch the map. The fault starts at the bottom and climbs: first the broken service, then everything that needs it, one layer at a time. Many services alert, but only one is actually broken. The rest are **symptoms**.',
      'Epicenter connects those alerts into **one incident** and marks where it started, the **epicenter**, with a ripple. It works that out from the graph: failures travel up from a service to its callers, never down, so the deepest alerting service is the likely cause.',
    ],
    points: [
      ['Blast radius', 'everything that depends on the epicenter and so can be affected.'],
      ['Confidence', 'how sure the app is about the epicenter.'],
    ],
    task: {
      label: 'Wait for the incident to appear in this panel (about 20 to 30 seconds).',
      done: (ctx) => {
        const run = lastRun(ctx, 'slow-db');
        if (run) return ctx.incidents.some((i) => !!i.epicenter && i.startedAt >= run.startedAt - SLACK_MS);
        return ctx.incidents.some((i) => !!i.epicenter && i.state === 'open');
      },
    },
  },
  {
    id: 'ladder',
    chapter: 'Diagnose',
    title: 'Metric, alert, incident',
    route: () => '/topology',
    place: 'Topology',
    body: ['Three words that are easy to mix up. They are a ladder, each built from the one before:'],
    points: [
      ['Metric', 'one number over time. "Database latency."'],
      ['Alert', 'one rule saying one metric on one node is abnormal. "Latency on this node is 8× normal."'],
      ['Incident', 'a group of related alerts with one cause. "The Database is slow, and that is why five other services are too."'],
    ],
  },

  // ------------------------------------------------------------ Learn
  {
    id: 'room',
    chapter: 'Learn',
    title: 'The incident room',
    route: (ctx) => {
      const inc = tourIncident(ctx);
      return inc ? `/incidents/${inc.id}` : '/incidents';
    },
    at: onIncidents,
    place: 'Incidents',
    target: 'replay-controls',
    body: [
      'Everything about one problem in one place: the epicenter, the map, the timeline of alerts and notes. If you are on the list, open the newest incident first.',
      'Real incidents are fast and stressful, so most of the learning happens afterwards, in a review called a **postmortem**. For that you need to see what happened, in order. Every incident here is a recording.',
    ],
    task: { label: 'Press Replay, then choose 16× and watch the failure spread again.', done: (ctx) => ctx.replaying },
  },
  {
    id: 'ttd',
    chapter: 'Learn',
    title: 'How fast was it caught?',
    route: (ctx) => {
      const inc = tourIncident(ctx);
      return inc ? `/incidents/${inc.id}` : '/incidents';
    },
    at: onIncidents,
    place: 'Incidents',
    target: 'incident-timeline',
    side: 'left',
    body: [
      'Drag the scrubber back to before the first alert marker: everything is healthy. Step forward to the moment latency leaves normal. That is the true start, usually a few seconds before the first alert in this timeline.',
      'The gap between the two is the **time to detect**. Shortening it without raising false alarms is one of the main things SREs work on. For a fault started in the Chaos Lab, the scorecard here shows it, and whether the right cause was named.',
      'Press **Go Live** to return to the present (shown while the incident is still open).',
    ],
  },

  // ------------------------------------------------------------ Pipeline
  {
    id: 'pipeline',
    chapter: 'Pipeline',
    title: 'How a number reaches your screen',
    route: () => '/pipeline',
    place: 'Pipeline',
    target: 'pipeline-stages',
    body: ['The monitoring system is itself a system that can be overloaded, so it reports on itself. One reading passes through six stages, left to right:'],
    points: [
      ['Ingest', 'receive readings; reject broken ones and refuse floods.'],
      ['Dedup', 'drop readings that arrived twice.'],
      ['Aggregate', 'one tidy point per node per second.'],
      ['Write', 'save history to the database.'],
      ['Broadcast', 'push only what changed to the browsers watching it.'],
      ['This browser', 'draw it, and measure how old it is. About 3 seconds, on purpose: the server waits briefly for late readings.'],
    ],
  },
  {
    id: 'storm-start',
    chapter: 'Pipeline',
    title: 'Attack the pipeline',
    roles: ADMIN,
    route: () => '/chaos',
    place: 'Chaos Lab',
    target: 'chaos-duplicate-storm',
    body: [
      'Networks retry, so the same reading often arrives more than once. Counted twice, it would distort every chart. This scenario sends every batch of readings three times, shuffled.',
    ],
    task: startTask('duplicate-storm', 'Duplicate storm'),
  },
  {
    id: 'storm-watch',
    chapter: 'Pipeline',
    title: 'Nothing happened. Good.',
    roles: ADMIN,
    route: () => '/pipeline',
    place: 'Pipeline',
    target: 'pipeline-stages',
    body: [
      'In stage 2, **Duplicates dropped** is climbing. Now look at the Overview or any node: nothing looks different.',
      'That is the result you want. The pipeline absorbed the mess before it reached a chart, and the counter is the proof that it did.',
    ],
  },

  // ------------------------------------------------------------ Wrap up
  {
    id: 'access',
    chapter: 'Access',
    title: 'Who sees what',
    body: [
      'Telemetry reveals sensitive things: traffic volumes, outages, internal names. So access is scoped by team and by role, and the server enforces it, not just the screen.',
      'To see it, sign out later and sign in as the Viewer: only the payments team\'s nodes and alerts exist for that account.',
    ],
    points: [
      ['Admin', 'sees everything and can run the Chaos Lab.'],
      ['SRE', 'sees everything, acknowledges alerts, writes incident notes.'],
      ['Viewer', 'sees only their own team\'s nodes, alerts and incidents.'],
    ],
  },
  {
    id: 'quiz',
    chapter: 'Check yourself',
    title: 'Check yourself',
    body: ['Answer each in your head, then open it.'],
    quiz: [
      { q: 'A hexagon is Silent. Is its CPU high or low?', a: 'You cannot know. Silent means no telemetry is arriving, so there is no CPU value at all. The node may be off, crashed or unreachable.' },
      { q: 'Six services are alerting on latency. Where do you look first?', a: 'At the one deepest in the dependency graph, the one the others call. Failures travel up from a dependency to its callers.' },
      { q: 'Payments and the Cache both show 80 ms latency. Which is in trouble?', a: 'The Cache. Its target is 5 ms; Payments\' target is 300 ms. Latency only means something next to the target for that service.' },
      { q: 'Why p95 and not the average?', a: 'The average hides slow requests behind many fast ones. p95 shows what the slowest one in twenty customers experiences.' },
      { q: 'What is the difference between an alert and an incident?', a: 'An alert is one rule firing for one metric on one node. An incident is a group of related alerts that share a cause.' },
      { q: 'During the duplicate storm the charts did not change. Did the test fail?', a: 'No, it passed. The duplicates were counted and dropped at the Dedup stage; steady dashboards are the proof.' },
    ],
  },
  {
    id: 'done',
    chapter: 'Finish',
    title: 'That is the loop',
    body: [
      'You observed a fleet, saw rules turn metrics into alerts, traced many symptoms to one cause, and replayed the incident to see how fast it was caught. That loop is the job.',
      'Keep exploring: try **Cache outage** and predict its blast radius first. You can run this tour again from the **Tour** button in the toolbar (or press T), see every shortcut key with **?**, and `demo.md` in the repository has the same walkthrough with a glossary.',
    ],
  },
];

// ---------------------------------------------------------------- queries

export const stepsFor = (role: Role): TourStep[] => TOUR_STEPS.filter((s) => !s.roles || s.roles.includes(role));

/** Where a step happens, or null when it has no page (or the page cannot be worked out yet). */
export const routeOf = (step: TourStep, ctx: TourCtx): string | null => step.route?.(ctx) ?? null;

/** Whether the user is on the page a step happens on. Steps with no page are "at" everywhere. */
export function isAt(step: TourStep, ctx: TourCtx): boolean {
  if (step.at) return step.at(ctx.pathname);
  if (!step.route) return true;
  return routeOf(step, ctx) === ctx.pathname;
}
