import { describe, expect, it } from 'vitest';
import { AGENT_BUFFER_CAP, IngestBatchSchema, INGEST_MAX_EVENTS, type IngestBatch } from '@epicenter/shared';
import { Agent, newBootId, parseRetryAfter, thinEvents, type Transport } from './agent';

const M = { cpu: 1, mem: 2, disk: 3, netIn: 4, netOut: 5, lat: 6, err: 0, rps: 7 };
const NODES = ['us-east-1a.db.01', 'us-east-1b.db.02'];

function harness(responses: (number | 'net' | { status: number; retryAfterSec: number })[]) {
  let t = 1_700_000_000_000;
  const sent: IngestBatch[] = [];
  const send: Transport = async (b) => {
    sent.push(structuredClone(b));
    const r = responses.shift() ?? 202;
    if (r === 'net') throw new Error('ECONNREFUSED');
    return typeof r === 'number' ? { status: r } : r;
  };
  let r = 0;
  const rand = () => (r = (r + 0.377) % 1);
  const agent = new Agent({ agentId: 'sim-us-east-1', nodeIds: NODES, send, now: () => t, rand });
  return { agent, sent, advance: (ms: number) => (t += ms), now: () => t };
}

describe('Agent', () => {
  it('assigns increasing seq per node and sends schema-valid batches', async () => {
    const h = harness([]);
    for (let i = 0; i < 3; i++) for (const n of NODES) h.agent.record(n, h.now(), M);
    await h.agent.flush();
    expect(h.sent).toHaveLength(1);
    expect(IngestBatchSchema.safeParse(h.sent[0]).success).toBe(true);
    const seqs = h.sent[0]!.events.filter((e) => e.nodeId === NODES[0]).map((e) => e.seq);
    expect(seqs).toEqual([0, 1, 2]);
    expect(h.agent.stats.buffer).toBe(0);
    expect(h.agent.stats.sent).toBe(6);
  });

  it('caps a batch at INGEST_MAX_EVENTS', async () => {
    const h = harness([]);
    for (let i = 0; i < INGEST_MAX_EVENTS + 20; i++) h.agent.record(NODES[0]!, h.now(), M);
    await h.agent.flush();
    expect(h.sent[0]!.events).toHaveLength(INGEST_MAX_EVENTS);
    await h.agent.flush();
    expect(h.sent[1]!.events).toHaveLength(20);
  });

  it('retries a network failure with the same seq values after a backoff', async () => {
    const h = harness(['net', 503]);
    for (const n of NODES) h.agent.record(n, h.now(), M);
    await h.agent.flush();
    await h.agent.flush(); // still backing off: no send
    expect(h.sent).toHaveLength(1);
    h.advance(10_000);
    await h.agent.flush(); // 503 → backoff again
    h.advance(10_000);
    await h.agent.flush(); // 202
    expect(h.sent).toHaveLength(3);
    const ids = h.sent.map((b) => b.events.map((e) => `${e.nodeId}:${e.bootId}:${e.seq}`).join(','));
    expect(new Set(ids).size).toBe(1);
    expect(h.agent.stats.retries).toBe(2);
    expect(h.agent.stats.buffer).toBe(0);
  });

  it('honours 429 Retry-After, then thins old samples to one per node per second', async () => {
    const h = harness([{ status: 429, retryAfterSec: 2 }]);
    // 10 s of samples at 5 Hz for one node
    for (let i = 0; i < 50; i++) {
      h.agent.record(NODES[0]!, h.now(), M);
      h.advance(200);
    }
    await h.agent.flush();
    expect(h.sent[0]!.events).toHaveLength(50);
    h.advance(1_000);
    await h.agent.flush(); // still inside Retry-After
    expect(h.sent).toHaveLength(1);
    h.advance(1_500);
    await h.agent.flush();
    expect(h.sent).toHaveLength(2);
    // samples older than 5 s collapse to 1/s; the newest 5 s stay at full rate
    expect(h.sent[1]!.events.length).toBeLessThan(50);
    expect(h.sent[1]!.events.length).toBeGreaterThanOrEqual(5 + 5 * 1);
    expect(h.agent.stats.thinned).toBeGreaterThan(0);
  });

  it('drops a batch the server rejects as a client error', async () => {
    const h = harness([400]);
    h.agent.record(NODES[0]!, h.now(), M);
    await h.agent.flush();
    expect(h.agent.stats.buffer).toBe(0);
    expect(h.agent.stats.dropped).toBe(1);
  });

  it('bounds the buffer and drops events that would be too old for the server', async () => {
    const h = harness([]);
    for (let i = 0; i < AGENT_BUFFER_CAP + 10; i++) h.agent.record(NODES[0]!, h.now(), M);
    expect(h.agent.stats.buffer).toBe(AGENT_BUFFER_CAP);
    expect(h.agent.stats.dropped).toBe(10);
    h.advance(58_000);
    await h.agent.flush();
    expect(h.sent).toHaveLength(0);
    expect(h.agent.stats.buffer).toBe(0);
  });

  it('a node restart gets a new bootId and seq 0', async () => {
    const h = harness([]);
    h.agent.record(NODES[0]!, h.now(), M);
    h.agent.restartNode(NODES[0]!);
    h.agent.record(NODES[0]!, h.now(), M);
    await h.agent.flush();
    const [a, b] = h.sent[0]!.events;
    expect(a!.bootId).not.toBe(b!.bootId);
    expect(b!.seq).toBe(0);
  });
});

describe('helpers', () => {
  it('thinEvents keeps recent events and one per node-second for old ones, in order', () => {
    const now = 100_000;
    const ev = (nodeId: string, ts: number) => ({ nodeId, ts });
    const input = [ev('a', 90_100), ev('a', 90_600), ev('b', 90_200), ev('a', 91_100), ev('a', 96_000), ev('a', 96_500)];
    expect(thinEvents(input, now)).toEqual([ev('a', 90_100), ev('b', 90_200), ev('a', 91_100), ev('a', 96_000), ev('a', 96_500)]);
  });

  it('parseRetryAfter handles seconds, missing and garbage', () => {
    expect(parseRetryAfter('2')).toBe(2);
    expect(parseRetryAfter(null)).toBe(1);
    expect(parseRetryAfter('soon', 3)).toBe(3);
  });

  it('newBootId matches the schema', () => {
    expect(newBootId()).toMatch(/^[a-z0-9]{6}$/);
  });
});
