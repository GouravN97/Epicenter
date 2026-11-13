import { describe, expect, it } from 'vitest';
import { TEAMS, buildFleet, type AuthClaims, type Team } from '@epicenter/shared';
import { CallLimiter, canJoin, expandRooms, planSub, type RoomContext } from './rooms';

const fleet = buildFleet();
const team = new Map(fleet.map((n) => [n.nodeId, n.team]));
const INC_PAY = 'a'.repeat(24);
const INC_DATA = 'b'.repeat(24);
const ctx: RoomContext = {
  nodeTeam: (id) => team.get(id),
  incidentTeams: (id) => (id === INC_PAY ? ['payments', 'commerce'] : id === INC_DATA ? ['data'] : undefined),
};
const user = (role: AuthClaims['role'], teams: Team[] = [...TEAMS]): AuthClaims => ({ sub: 'u', role, teams, name: 'n' });
const admin = user('admin');
const sre = user('sre');
const viewer = user('viewer', ['payments']);
const payNode = fleet.find((n) => n.team === 'payments')!.nodeId;
const dbNode = fleet.find((n) => n.serviceId === 'db')!.nodeId;

describe('canJoin', () => {
  it('admins and SREs may join every real room', () => {
    for (const u of [admin, sre]) {
      for (const r of ['fleet:data', 'alerts:platform', `node:${dbNode}`, 'service:db', 'topology', 'meta', `incident:${INC_DATA}`]) {
        expect(canJoin(u, r, ctx), `${u.role} ${r}`).toBe(true);
      }
    }
  });

  it('nobody may join rooms that name nothing real', () => {
    for (const r of ['fleet:hr', 'node:us-east-1a.db.99', 'service:mainframe', 'incident:123', 'lobby', 'fleet:', '', 'node']) {
      expect(canJoin(admin, r, ctx), r).toBe(false);
    }
  });

  it('a payments viewer only gets payments data', () => {
    expect(canJoin(viewer, 'fleet:payments', ctx)).toBe(true);
    expect(canJoin(viewer, 'alerts:payments', ctx)).toBe(true);
    expect(canJoin(viewer, `node:${payNode}`, ctx)).toBe(true);
    expect(canJoin(viewer, 'service:payments', ctx)).toBe(true);
    expect(canJoin(viewer, `incident:${INC_PAY}`, ctx)).toBe(true);

    expect(canJoin(viewer, 'fleet:data', ctx)).toBe(false);
    expect(canJoin(viewer, 'alerts:commerce', ctx)).toBe(false);
    expect(canJoin(viewer, `node:${dbNode}`, ctx)).toBe(false);
    expect(canJoin(viewer, 'service:db', ctx)).toBe(false);
    expect(canJoin(viewer, `incident:${INC_DATA}`, ctx)).toBe(false);
    expect(canJoin(viewer, `incident:${'c'.repeat(24)}`, ctx)).toBe(false); // unknown incident
  });

  it('topology and meta (aggregates only) are open to viewers', () => {
    expect(canJoin(viewer, 'topology', ctx)).toBe(true);
    expect(canJoin(viewer, 'meta', ctx)).toBe(true);
  });
});

describe('expandRooms', () => {
  it('expands fleet:* to permitted team rooms and dedups', () => {
    expect(expandRooms(viewer, ['fleet:*', 'fleet:payments', 'topology'])).toEqual(['fleet:payments', 'topology']);
    expect(expandRooms(admin, ['fleet:*'])).toEqual(TEAMS.map((t) => `fleet:${t}`));
  });

  it('ignores junk input', () => {
    expect(expandRooms(admin, 'fleet:*')).toEqual([]);
    expect(expandRooms(admin, [1, null, 'meta'])).toEqual(['meta']);
  });
});

describe('planSub', () => {
  it('splits joined and denied, and keeps already-joined rooms joined', () => {
    const p = planSub(viewer, ['fleet:payments', 'fleet:data', 'meta'], new Set(['meta']), ctx);
    expect(p).toEqual({ joined: ['fleet:payments', 'meta'], denied: ['fleet:data'] });
  });

  it('enforces the per-socket room cap', () => {
    const p = planSub(admin, ['topology', 'meta', 'fleet:data'], new Set(['fleet:platform']), ctx, 3);
    expect(p).toEqual({ joined: ['topology', 'meta'], denied: ['fleet:data'] });
  });
});

describe('CallLimiter', () => {
  it('allows 20 calls per 10 s window', () => {
    const l = new CallLimiter(20, 10_000);
    for (let i = 0; i < 20; i++) expect(l.allow(1000 + i)).toBe(true);
    expect(l.allow(1100)).toBe(false);
    expect(l.allow(11_000)).toBe(true); // first call has left the window
  });
});
