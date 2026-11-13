// Room access control (plan §7.2). Pure: everything it needs about nodes and incidents comes in `ctx`.
import {
  SOCKET_MAX_ROOMS,
  SOCKET_SUB_LIMIT,
  SOCKET_SUB_WINDOW_MS,
  TEAMS,
  isServiceId,
  parseRoom,
  room,
  teamOfService,
  type AuthClaims,
  type Team,
} from '@epicenter/shared';

export interface RoomContext {
  /** Team owning a node, or undefined for unknown nodes. */
  nodeTeam(nodeId: string): Team | undefined;
  /** Teams an incident touches, or undefined if the incident is unknown (A9). */
  incidentTeams(incidentId: string): Team[] | undefined;
}

const isTeam = (x: string): x is Team => (TEAMS as readonly string[]).includes(x);
const OBJECT_ID = /^[a-f0-9]{24}$/i;

/** Teams whose data a user may see. Admins and SREs see everything. */
export const visibleTeams = (u: AuthClaims): Team[] => (u.role === 'viewer' ? u.teams : [...TEAMS]);

/**
 * Whether a user may join a room. Rooms must name something real (a known node, a real service or team).
 * Admins and SREs may join any of them. Viewers only see their own teams' data. `topology` and `meta` are
 * service- and pipeline-level aggregates with no per-node data and are open to every signed-in user.
 */
export function canJoin(u: AuthClaims, name: string, ctx: RoomContext): boolean {
  const r = parseRoom(name);
  if (!r) return false;
  const all = u.role !== 'viewer';
  const mine = (t: Team | undefined) => t !== undefined && (all || u.teams.includes(t));
  switch (r.kind) {
    case 'topology':
    case 'meta':
      return true;
    case 'fleet':
    case 'alerts':
      return isTeam(r.arg) && mine(r.arg);
    case 'node':
      return mine(ctx.nodeTeam(r.arg));
    case 'service':
      return isServiceId(r.arg) && mine(teamOfService(r.arg));
    case 'incident': {
      if (!OBJECT_ID.test(r.arg)) return false;
      if (all) return true;
      const teams = ctx.incidentTeams(r.arg);
      return !!teams && teams.some((t) => u.teams.includes(t));
    }
  }
}

/** Expands the `fleet:*` shorthand into the user's permitted fleet rooms, and drops duplicates. */
export function expandRooms(u: AuthClaims, rooms: unknown): string[] {
  if (!Array.isArray(rooms)) return [];
  const out = new Set<string>();
  for (const r of rooms) {
    if (typeof r !== 'string') continue;
    if (r === room.fleetAll) for (const t of visibleTeams(u)) out.add(room.fleet(t));
    else out.add(r);
  }
  return [...out];
}

/** Sliding-window limiter for sub/unsub calls on one socket (20 per 10 s). */
export class CallLimiter {
  private calls: number[] = [];
  constructor(
    private readonly limit = SOCKET_SUB_LIMIT,
    private readonly windowMs = SOCKET_SUB_WINDOW_MS,
  ) {}

  allow(now: number): boolean {
    while (this.calls.length && this.calls[0]! <= now - this.windowMs) this.calls.shift();
    if (this.calls.length >= this.limit) return false;
    this.calls.push(now);
    return true;
  }
}

export interface SubPlan {
  joined: string[];
  denied: string[];
}

/**
 * Decides which requested rooms a socket joins: permitted, and within the per-socket cap (`current` = rooms
 * the socket is in now, excluding its private id room).
 */
export function planSub(u: AuthClaims, requested: string[], current: Set<string>, ctx: RoomContext, maxRooms = SOCKET_MAX_ROOMS): SubPlan {
  const joined: string[] = [];
  const denied: string[] = [];
  let count = current.size;
  for (const r of requested) {
    if (current.has(r)) {
      joined.push(r);
    } else if (count < maxRooms && canJoin(u, r, ctx)) {
      joined.push(r);
      count++;
    } else denied.push(r);
  }
  return { joined, denied };
}
