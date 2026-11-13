import { describe, expect, it } from 'vitest';
import { METRICS, type ColumnarSeries, type FleetDelta, type NodePt, type UserDTO } from '@epicenter/shared';
import { MockBackend, MOCK_LAG_SEC } from '../mocks/mockBackend';
import { MockSocket } from '../mocks/mockSocket';
import { FAULT_CYCLE } from '../mocks/mockWorld';
import { Clock } from './clock';
import { FleetState } from './fleetState';
import { RoomManager, type RoomSocket } from './RoomManager';
import { openSeries } from './seriesSession';
import { TelemetryStore } from './TelemetryStore';

const admin: UserDTO = { id: 'a', email: 'admin@epicenter.dev', name: 'Admin', role: 'admin', teams: ['platform', 'commerce', 'payments', 'data'] };
const viewer: UserDTO = { id: 'v', email: 'payments@epicenter.dev', name: 'Viewer', role: 'viewer', teams: ['payments'] };
const T0 = 5 * 1_000_000 * FAULT_CYCLE + 20; // a quiet stretch of the mock fault schedule
const tick = () => new Promise<void>((r) => setTimeout(r, 0)); // lets microtasks and resolved fetches run

function world(user: UserDTO = admin) {
  let nowSec = T0 + MOCK_LAG_SEC;
  const backend = new MockBackend({ now: () => nowSec * 1000 });
  backend.advance();
  const socket = new MockSocket(backend, user, 't', { latencyMs: 0 });
  const subs: string[][] = [];
  const unsubs: string[][] = [];
  const emit = socket.emit.bind(socket);
  socket.emit = ((event: string, ...args: unknown[]) => {
    if (event === 'sub') subs.push((args[0] as { rooms: string[] }).rooms);
    if (event === 'unsub') unsubs.push((args[0] as { rooms: string[] }).rooms);
    return (emit as (...a: unknown[]) => unknown)(event, ...args);
  }) as typeof socket.emit;
  socket.connect();
  return {
    backend,
    socket,
    subs,
    unsubs,
    now: () => nowSec * 1000,
    at(sec: number) {
      nowSec = sec + MOCK_LAG_SEC;
      backend.advance();
    },
  };
}

describe('TelemetryStore', () => {
  function manual() {
    const frames: (() => void)[] = [];
    let hidden = false;
    const store = new TelemetryStore({ raf: (cb) => frames.push(cb), isHidden: () => hidden });
    return { store, frames, frame: () => frames.splice(0).forEach((f) => f()), hide: (h: boolean) => (hidden = h) };
  }

  it('redraws a dirty key once per frame however many points arrived', () => {
    const { store, frames, frame } = manual();
    store.acquire('node:a', 2);
    let draws = 0;
    store.addDrawer('node:a', () => draws++);
    frame();
    expect(draws).toBe(1); // initial draw

    for (let i = 1; i <= 50; i++) store.upsert('node:a', i, [i, i]);
    expect(frames).toHaveLength(1); // one frame requested for 50 points
    frame();
    expect(draws).toBe(2);
    frame();
    expect(draws).toBe(2); // nothing dirty, nothing drawn
    expect(frames).toHaveLength(0); // and no frame requested while idle
  });

  it('does not redraw for duplicate points, other keys, or off-screen drawers', () => {
    const { store, frames, frame } = manual();
    store.acquire('node:a', 1);
    store.acquire('node:b', 1);
    let a = 0;
    let b = 0;
    store.addDrawer('node:a', () => a++);
    const drawerB = store.addDrawer('node:b', () => b++);
    frame();
    [a, b] = [0, 0];

    store.upsert('node:a', 1, [1]);
    frame();
    expect([a, b]).toEqual([1, 0]);

    store.upsert('node:a', 1, [1]); // exact duplicate
    expect(frames).toHaveLength(0);

    drawerB.setVisible(false);
    store.upsert('node:b', 1, [1]);
    frame();
    expect(b).toBe(0);
    drawerB.setVisible(true); // back on screen: one catch-up draw
    frame();
    expect(b).toBe(1);
  });

  it('pauses drawing while the tab is hidden and keeps the key dirty', () => {
    const { store, frame, hide } = manual();
    store.acquire('node:a', 1);
    let draws = 0;
    store.addDrawer('node:a', () => draws++);
    frame();
    hide(true);
    store.upsert('node:a', 1, [1]);
    frame();
    expect(draws).toBe(1);
    hide(false);
    store.markDirty('node:a');
    frame();
    expect(draws).toBe(2);
  });

  it('drops points for keys nobody holds and frees a buffer on its last release', () => {
    const { store } = manual();
    store.upsert('node:x', 1, [1]);
    expect(store.get('node:x')).toBeUndefined();
    const b1 = store.acquire('node:x', 1);
    expect(store.acquire('node:x', 1)).toBe(b1);
    store.release('node:x');
    expect(store.get('node:x')).toBe(b1);
    store.release('node:x');
    expect(store.get('node:x')).toBeUndefined();
  });
});

describe('RoomManager', () => {
  it('shares one subscription between users of a room and unsubscribes on the last release', async () => {
    const w = world();
    const rooms = new RoomManager();
    rooms.attach(w.socket as unknown as RoomSocket);
    const r1 = rooms.acquire('topology');
    const r2 = rooms.acquire('topology');
    await tick();
    expect(w.subs).toEqual([['topology']]);
    expect(rooms.state('topology')).toBe('joined');

    r1();
    await tick();
    expect(w.unsubs).toEqual([]);
    r2();
    r2(); // releasing twice is harmless
    await tick();
    expect(w.unsubs).toEqual([['topology']]);
    expect(w.socket.joinedRooms()).toEqual([]);
    expect(rooms.state('topology')).toBeUndefined();
  });

  it('batches a page of subscriptions into one call and skips release-then-reacquire', async () => {
    const w = world();
    const rooms = new RoomManager();
    rooms.attach(w.socket as unknown as RoomSocket);
    const releases = ['topology', 'meta', 'fleet:data', 'fleet:payments'].map((r) => rooms.acquire(r));
    await tick();
    expect(w.subs).toEqual([['topology', 'meta', 'fleet:data', 'fleet:payments']]);

    releases[0]!(); // as React StrictMode does: unmount, then mount again in the same tick
    rooms.acquire('topology');
    await tick();
    expect(w.subs).toHaveLength(1);
    expect(w.unsubs).toHaveLength(0);
    expect(rooms.state('topology')).toBe('joined');
  });

  it('reports rooms the server denies', async () => {
    const w = world(viewer);
    const rooms = new RoomManager();
    rooms.attach(w.socket as unknown as RoomSocket);
    let changes = 0;
    rooms.subscribe(() => changes++);
    rooms.acquire('fleet:payments');
    rooms.acquire('fleet:data');
    expect(rooms.state('fleet:data')).toBe('pending');
    await tick();
    expect(rooms.state('fleet:payments')).toBe('joined');
    expect(rooms.state('fleet:data')).toBe('denied');
    expect(changes).toBeGreaterThan(0);
  });

  it('re-joins every room in use after a reconnect, then announces it', async () => {
    const w = world();
    const rooms = new RoomManager();
    rooms.attach(w.socket as unknown as RoomSocket);
    rooms.acquire('topology');
    rooms.acquire('meta');
    await tick();
    const events: string[] = [];
    rooms.onConnection((ev) => events.push(`${ev}:${w.socket.joinedRooms().length}`));

    w.socket.down();
    expect(rooms.state('topology')).toBe('pending');
    w.socket.up();
    expect(events).toEqual(['disconnect:0', 'reconnect:2']); // rooms are back before listeners hear "reconnect"
    expect(rooms.state('topology')).toBe('joined');
    expect(w.subs.at(-1)).toEqual(['topology', 'meta']);
  });

  it('joins rooms acquired before the socket existed', async () => {
    const w = world();
    const rooms = new RoomManager();
    rooms.acquire('topology');
    await tick();
    expect(w.subs).toEqual([]);
    rooms.attach(w.socket as unknown as RoomSocket);
    expect(w.subs).toEqual([['topology']]);
  });
});

describe('series session: history + live + reconnect', () => {
  function setup() {
    const w = world();
    const node = w.backend.world.nodes[10]!;
    const key = `node:${node.nodeId}`;
    const store = new TelemetryStore({ raf: () => 0, isHidden: () => false });
    const rooms = new RoomManager();
    rooms.attach(w.socket as unknown as RoomSocket);
    w.socket.on('node:pt', ((p: NodePt) => store.upsert(key, p[1], p, 2, p[10])) as never);

    const pending: (() => void)[] = [];
    let hold = false;
    let fetches = 0;
    const ranges: [number, number][] = [];
    const deps = {
      store,
      rooms,
      now: w.now,
      fetchHistory: (_room: string, from: number, to: number): Promise<ColumnarSeries> => {
        fetches++;
        ranges.push([from, to]);
        const res = w.backend.nodeSeries(admin, node.nodeId, from, to); // computed at request time
        return hold ? new Promise((resolve) => pending.push(() => resolve(res))) : Promise.resolve(res);
      },
    };
    /** What the buffer must equal: the server's history for the same window, nothing more or less. */
    const reference = (rangeMs: number) => w.backend.nodeSeries(admin, node.nodeId, w.now() - rangeMs, w.now());
    const expectMatches = (buf: ReturnType<typeof store.acquire>, ref: ColumnarSeries) => {
      expect([...buf.times()]).toEqual(ref.t);
      METRICS.forEach((m, c) => expect([...buf.column(c)]).toEqual(ref[m].map(Math.fround)));
    };
    return { w, key, store, rooms, deps, pending, holdFetches: (h: boolean) => (hold = h), fetchCount: () => fetches, ranges, reference, expectMatches };
  }
  const RANGE = 5 * 60_000;

  it('subscribes before fetching, and merges late history with live points without duplicates', async () => {
    const s = setup();
    s.holdFetches(true);
    const session = openSeries(s.deps, s.key, RANGE);
    await tick();
    expect(s.w.subs).toEqual([[s.key]]); // step 1 happened; the history response is still in flight
    expect(session.state().status).toBe('loading');

    s.w.at(T0 + 8); // 8 live points land first
    expect(session.buffer.length).toBe(8);

    s.pending.splice(0).forEach((resolve) => resolve()); // the history response arrives after the live points
    await tick();
    expect(session.state().status).toBe('ready');
    expect(session.buffer.length).toBe(298 + 8); // 298 finalized seconds of history, then the 8 live points
    s.expectMatches(session.buffer, s.reference(RANGE + 8000));
    session.close();
  });

  it('heals the gap left by a dropped connection', async () => {
    const s = setup();
    const session = openSeries(s.deps, s.key, RANGE);
    await tick();
    s.w.at(T0 + 10);

    s.w.socket.down();
    s.w.at(T0 + 30); // 20 seconds of points are never delivered
    expect(session.buffer.lastT).toBe((T0 + 10) * 1000);

    s.w.socket.up();
    await tick();
    s.w.at(T0 + 40);

    expect(session.buffer.lastT).toBe((T0 + 40) * 1000);
    s.expectMatches(session.buffer, s.reference(RANGE + 40_000));
    // The gap-fill asked only for the missing stretch (plus the 5 s overlap), not the whole range again.
    expect(s.ranges.at(-1)).toEqual([(T0 + 10) * 1000 - 5000, s.ranges.at(-1)![1]]);
    expect(s.fetchCount()).toBe(2);
    session.close();
  });

  it('is unchanged by replayed live points and a repeated history load', async () => {
    const s = setup();
    const session = openSeries(s.deps, s.key, RANGE);
    const replay: NodePt[] = [];
    s.w.socket.on('node:pt', ((p: NodePt) => replay.push(p)) as never);
    await tick();
    s.w.at(T0 + 20);

    const before = { v: session.buffer.version, t: [...session.buffer.times()], cpu: [...session.buffer.column(0)] };
    for (const p of [...replay].reverse()) s.store.upsert(s.key, p[1], p, 2, p[10]);
    session.reload();
    await tick();
    expect(session.buffer.version).toBe(before.v);
    expect([...session.buffer.times()]).toEqual(before.t);
    expect([...session.buffer.column(0)]).toEqual(before.cpu);
    session.close();
  });

  it('two sessions on one room share the buffer and the subscription', async () => {
    const s = setup();
    const a = openSeries(s.deps, s.key, RANGE);
    const b = openSeries(s.deps, s.key, RANGE);
    await tick();
    expect(a.buffer).toBe(b.buffer);
    expect(s.w.subs).toEqual([[s.key]]);
    a.close();
    await tick();
    expect(s.w.unsubs).toEqual([]);
    s.w.at(T0 + 3);
    expect(b.buffer.lastT).toBe((T0 + 3) * 1000); // still live for the remaining user
    b.close();
    await tick();
    expect(s.w.unsubs).toEqual([[s.key]]);
    expect(s.store.get(s.key)).toBeUndefined();
  });

  it('surfaces a failed history load and recovers on reload', async () => {
    const s = setup();
    let fail = true;
    const ok = s.deps.fetchHistory;
    s.deps.fetchHistory = (...args) => (fail ? Promise.reject(new Error('Cannot reach the Epicenter API')) : ok(...args));
    const session = openSeries(s.deps, s.key, RANGE);
    const seen: string[] = [];
    session.subscribe((st) => seen.push(st.status));
    await tick();
    expect(session.state()).toEqual({ status: 'error', message: 'Cannot reach the Epicenter API' });
    fail = false;
    session.reload();
    await tick();
    expect(seen).toEqual(['loading', 'error', 'loading', 'ready']);
    session.close();
  });
});

describe('FleetState', () => {
  it('applies deltas in place and grows for unknown node indexes', () => {
    const f = new FleetState();
    f.resize(4);
    expect(f.apply([100, [0, 40, 50, 0], [2, 91, 60, 2]] as FleetDelta)).toBe(2);
    expect([...f.cpu]).toEqual([40, 0, 91, 0]);
    expect([...f.seen]).toEqual([1, 0, 1, 0]);
    expect(f.statusCounts()).toEqual([1, 0, 1, 0]);

    f.apply([101, [2, 55, 60, 0], [6, 10, 10, 3]] as FleetDelta);
    expect(f.size).toBe(7);
    expect([f.cpu[0], f.cpu[2], f.status[2], f.status[6]]).toEqual([40, 55, 0, 3]);
    expect(f.tsSec).toBe(101);
    expect(f.statusCounts()).toEqual([2, 0, 0, 1]);
  });

  it('follows the mock fleet stream to the same state as a fresh full snapshot', () => {
    const w = world();
    const live = new FleetState();
    w.socket.on('fleet:delta', ((d: FleetDelta) => live.apply(d)) as never);
    w.socket.emit('sub', { rooms: ['fleet:data', 'fleet:commerce'] }, () => {});
    w.at(T0 + 120);

    const fresh = new FleetState();
    const late = new MockSocket(w.backend, admin, 't', { latencyMs: 0 });
    late.on('fleet:delta', ((d: FleetDelta) => fresh.apply(d)) as never);
    late.connect();
    late.emit('sub', { rooms: ['fleet:data', 'fleet:commerce'] }, () => {});

    expect([...live.status]).toEqual([...fresh.status]);
    expect([...live.seen]).toEqual([...fresh.seen]);
    // Deltas skip moves under 1 point, so the running state may trail a fresh snapshot by at most that.
    for (let i = 0; i < live.size; i++) expect(Math.abs(live.cpu[i]! - fresh.cpu[i]!)).toBeLessThan(1);
  });
});

describe('Clock', () => {
  it('runs live on server time and replays at a chosen speed', () => {
    let wall = 1_000_000;
    let perf = 0;
    const clock = new Clock({ wall: () => wall, perf: () => perf });
    clock.addTimeSample(wall, wall + 520, wall + 40); // rtt 40 → offset 500
    clock.addTimeSample(wall, wall + 900, wall + 300); // slower sample is ignored
    expect(clock.offsetMs).toBe(500);
    expect(clock.now()).toBe(1_000_500);

    let notified = 0;
    clock.subscribe(() => notified++);
    clock.startReplay(50_000, { speed: 16 });
    expect(clock.getSnapshot()).toEqual({ mode: 'replay', speed: 16, playing: false });
    perf += 1000;
    expect(clock.now()).toBe(50_000); // paused

    clock.play();
    perf += 1000;
    expect(clock.now()).toBe(66_000); // 1 s at 16×
    clock.setSpeed(4);
    perf += 1000;
    expect(clock.now()).toBe(70_000);
    clock.pause();
    perf += 5000;
    expect(clock.now()).toBe(70_000);
    clock.seek(60_000);
    expect(clock.now()).toBe(60_000);

    wall += 9000;
    clock.goLive();
    expect(clock.mode).toBe('live');
    expect(clock.now()).toBe(1_009_500);
    expect(notified).toBeGreaterThanOrEqual(5);
  });
});
