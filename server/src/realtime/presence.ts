// Who is looking at each incident room (plan §7.2 presence:hello, §7.3 presence). Tracked per socket and
// reported per user, so one person with two tabs shows once.
import type { PresenceUser } from '@epicenter/shared';

export class Presence {
  /** incidentId → socketId → user */
  private readonly rooms = new Map<string, Map<string, PresenceUser>>();

  join(incidentId: string, socketId: string, user: PresenceUser): PresenceUser[] {
    let m = this.rooms.get(incidentId);
    if (!m) this.rooms.set(incidentId, (m = new Map()));
    m.set(socketId, user);
    return this.users(incidentId);
  }

  /** Returns the remaining users, or null if the socket was not present. */
  leave(incidentId: string, socketId: string): PresenceUser[] | null {
    const m = this.rooms.get(incidentId);
    if (!m?.delete(socketId)) return null;
    if (m.size === 0) this.rooms.delete(incidentId);
    return this.users(incidentId);
  }

  /** Removes a socket everywhere (disconnect). Returns the incidents whose user list changed. */
  leaveAll(socketId: string): string[] {
    const changed: string[] = [];
    for (const id of [...this.rooms.keys()]) if (this.leave(id, socketId)) changed.push(id);
    return changed;
  }

  users(incidentId: string): PresenceUser[] {
    const m = this.rooms.get(incidentId);
    if (!m) return [];
    const byId = new Map<string, PresenceUser>();
    for (const u of m.values()) byId.set(u.id, u);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
