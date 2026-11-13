// Ref-counted Socket.IO room subscriptions (plan §9.2).
//  - two components on one room share one server-side subscription
//  - sub/unsub requests made in the same tick are batched into one emit each (the server allows a socket
//    20 sub/unsub calls per 10 s, and a page of charts would otherwise burn through that on mount)
//  - a reconnect loses every room on the server, so all rooms in use are re-joined on `connect`
import type { DashC2S, SubAck } from '@epicenter/shared';

export type RoomState = 'pending' | 'joined' | 'denied';
export type ConnectionEvent = 'disconnect' | 'reconnect';

/** The part of the socket this module needs; the real socket and the mock both satisfy it. */
export interface RoomSocket {
  connected: boolean;
  on(event: 'connect' | 'disconnect', fn: () => void): unknown;
  off(event: 'connect' | 'disconnect', fn: () => void): unknown;
  emit<E extends 'sub' | 'unsub'>(event: E, ...args: Parameters<DashC2S[E]>): unknown;
}

export class RoomManager {
  private socket: RoomSocket | null = null;
  private readonly counts = new Map<string, number>();
  private readonly states = new Map<string, RoomState>();
  /** Rooms the server has this socket in, as far as we know. Emptied by a disconnect. */
  private readonly onServer = new Set<string>();
  private readonly joinQueue = new Set<string>();
  private readonly leaveQueue = new Set<string>();
  private flushQueued = false;
  private connectedOnce = false;
  private readonly stateListeners = new Set<() => void>();
  private readonly connListeners = new Set<(ev: ConnectionEvent) => void>();

  private readonly onConnect = () => {
    const reconnect = this.connectedOnce;
    this.connectedOnce = true;
    this.joinQueue.clear();
    this.leaveQueue.clear();
    this.onServer.clear();
    const rooms = [...this.counts.keys()];
    for (const r of rooms) this.states.set(r, 'pending');
    this.notify();
    // Re-join first, then announce: live points are flowing again before anyone fetches the gap.
    this.sub(rooms, () => {
      if (reconnect) for (const fn of [...this.connListeners]) fn('reconnect');
    });
  };

  private readonly onDisconnect = () => {
    this.onServer.clear();
    for (const r of this.counts.keys()) this.states.set(r, 'pending');
    this.notify();
    for (const fn of [...this.connListeners]) fn('disconnect');
  };

  /** Switches to a new socket (login) or to none (logout). */
  attach(socket: RoomSocket | null): void {
    if (socket === this.socket) return;
    this.socket?.off('connect', this.onConnect);
    this.socket?.off('disconnect', this.onDisconnect);
    this.socket = socket;
    this.connectedOnce = false;
    this.onServer.clear();
    for (const r of this.counts.keys()) this.states.set(r, 'pending');
    this.notify();
    if (!socket) return;
    socket.on('connect', this.onConnect);
    socket.on('disconnect', this.onDisconnect);
    if (socket.connected) this.onConnect();
  }

  /** Takes a reference on `room`. Returns the function that releases it (safe to call twice). */
  acquire(room: string): () => void {
    const n = (this.counts.get(room) ?? 0) + 1;
    this.counts.set(room, n);
    if (n === 1) {
      // Released and re-acquired before the unsub went out: the server still has us in the room.
      this.states.set(room, this.onServer.has(room) ? 'joined' : 'pending');
      this.joinQueue.add(room);
      this.queueFlush();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(room) ?? 1) - 1;
      if (left > 0) {
        this.counts.set(room, left);
      } else {
        this.counts.delete(room);
        this.states.delete(room);
        this.leaveQueue.add(room);
        this.queueFlush();
      }
    };
  }

  state(room: string): RoomState | undefined {
    return this.states.get(room);
  }

  /** Rooms currently in use by at least one caller. */
  rooms(): string[] {
    return [...this.counts.keys()];
  }

  /** Called when any room's state changes. */
  subscribe(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /** `disconnect` when the connection drops; `reconnect` after it is back and rooms are re-joined. */
  onConnection(fn: (ev: ConnectionEvent) => void): () => void {
    this.connListeners.add(fn);
    return () => this.connListeners.delete(fn);
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  /** Sends the batched changes. A room released and re-acquired in the same tick sends nothing. */
  private flush(): void {
    this.flushQueued = false;
    const joins = [...this.joinQueue].filter((r) => this.counts.has(r) && !this.onServer.has(r));
    const leaves = [...this.leaveQueue].filter((r) => !this.counts.has(r) && this.onServer.has(r));
    this.joinQueue.clear();
    this.leaveQueue.clear();
    if (!this.socket?.connected) return; // onConnect joins everything in use
    for (const r of leaves) this.onServer.delete(r);
    if (leaves.length) this.socket.emit('unsub', { rooms: leaves }, () => {});
    this.sub(joins);
  }

  private sub(rooms: string[], done?: () => void): void {
    if (!rooms.length || !this.socket) return done?.();
    this.socket.emit('sub', { rooms }, (ack: SubAck) => {
      for (const r of rooms) {
        const denied = ack.denied.includes(r);
        if (!denied) this.onServer.add(r);
        if (this.counts.has(r)) this.states.set(r, denied ? 'denied' : 'joined');
        else if (!denied) this.leaveQueue.add(r); // released while the request was in flight
      }
      if (this.leaveQueue.size) this.queueFlush();
      this.notify();
      done?.();
    });
  }

  private notify(): void {
    for (const fn of [...this.stateListeners]) fn();
  }
}
