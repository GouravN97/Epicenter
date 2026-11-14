// Persists and broadcasts the detector's alert lifecycle (plan §8.6: "persisted to `alerts` on state changes
// only"). Writes are fire-and-forget off the hot path, chained per alert so an update never overtakes the
// insert it depends on.
import { Types } from 'mongoose';
import type { AlertDTO } from '@epicenter/shared';
import { AlertModel } from '../db/models';
import type { Detector } from './detector';

const oid = (id: string | null | undefined) => (id ? new Types.ObjectId(id) : null);

export function alertToDoc(a: AlertDTO) {
  return {
    _id: new Types.ObjectId(a.id),
    key: a.key,
    nodeId: a.nodeId,
    serviceId: a.serviceId,
    team: a.team,
    metric: a.metric,
    rule: a.rule,
    severity: a.severity,
    state: a.state,
    value: a.value,
    threshold: a.threshold,
    message: a.message,
    startedAt: new Date(a.startedAt),
    ackedBy: oid(a.ackedBy),
    resolvedAt: a.resolvedAt ? new Date(a.resolvedAt) : null,
    incidentId: oid(a.incidentId),
  };
}

type AlertDocLike = ReturnType<typeof alertToDoc>;

export function docToAlert(d: AlertDocLike): AlertDTO {
  return {
    id: d._id.toString(),
    key: d.key,
    nodeId: d.nodeId,
    serviceId: d.serviceId,
    team: d.team,
    metric: d.metric,
    rule: d.rule,
    severity: d.severity,
    state: d.state,
    value: d.value,
    threshold: d.threshold,
    message: d.message,
    startedAt: d.startedAt.getTime(),
    ackedBy: d.ackedBy?.toString() ?? null,
    resolvedAt: d.resolvedAt?.getTime() ?? null,
    incidentId: d.incidentId?.toString() ?? null,
  };
}

export type AlertEmit = (event: 'alert:new' | 'alert:upd', a: AlertDTO) => void;

export class AlertStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly emit: AlertEmit) {}

  attach(detector: Detector): void {
    detector.on({
      fire: (a) => {
        this.emit('alert:new', a);
        this.persist(a.id, () => AlertModel.collection.insertOne(alertToDoc(a)));
      },
      update: (a) => this.changed(a),
      resolve: (a) => this.changed(a),
    });
  }

  /** Broadcast and persist a changed alert (also used when the correlator links an incident, A9). */
  changed(a: AlertDTO): void {
    this.emit('alert:upd', a);
    const { _id, ...rest } = alertToDoc(a);
    this.persist(a.id, () => AlertModel.collection.updateOne({ _id }, { $set: rest }));
  }

  private persist(id: string, op: () => Promise<unknown>): void {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev
      .then(op)
      .catch((err) => console.error(`[alerts] persist ${id} failed:`, err instanceof Error ? err.message : err))
      .finally(() => {
        if (this.chains.get(id) === next) this.chains.delete(id);
      });
    this.chains.set(id, next);
  }

  /** Waits for pending writes (shutdown, tests). */
  async drain(): Promise<void> {
    while (this.chains.size) await Promise.all(this.chains.values());
  }
}

/**
 * On boot the detector's memory is empty, so alerts left firing by a previous process can never resolve.
 * Close them so the UI does not show zombies.
 */
export async function resolveStaleAlerts(now = new Date()): Promise<number> {
  const r = await AlertModel.updateMany({ state: { $in: ['firing', 'acked'] } }, { $set: { state: 'resolved', resolvedAt: now } });
  return r.modifiedCount;
}
