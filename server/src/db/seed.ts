// npm run seed — idempotent. Upserts the three demo users, one agent per region and the 48-node fleet, then
// makes the database indexes match the schemas. Passwords and the agent key come from .env only.
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { REGIONS, TEAMS, agentIdForRegion, buildFleet, type Role, type Team } from '@epicenter/shared';
import { config, requireEnv } from '../config';
import { hashAgentKey } from '../lib/agentKey';
import { connectDb, disconnectDb, syncIndexes } from './connect';
import { ALL_MODELS, AgentModel, NodeModel, UserModel } from './models';

/** Per-agent token bucket. One region = 16 nodes × 2 Hz = 32 ev/s normally; traffic-surge (×5 hz) plus a
 *  duplicate storm (×3) is ~480 ev/s, so leave headroom. */
const SIM_AGENT_RATE = 1000;
const SIM_AGENT_BURST = 2000;

const USERS: { email: string; name: string; role: Role; teams: readonly Team[]; pw: () => string }[] = [
  { email: 'admin@epicenter.dev', name: 'Admin', role: 'admin', teams: TEAMS, pw: () => config.seedPasswords.admin },
  { email: 'sre@epicenter.dev', name: 'SRE On-call', role: 'sre', teams: TEAMS, pw: () => config.seedPasswords.sre },
  { email: 'payments@epicenter.dev', name: 'Payments Viewer', role: 'viewer', teams: ['payments'], pw: () => config.seedPasswords.viewer },
];

async function main(): Promise<void> {
  requireEnv('MONGODB_URI', 'SIM_KEY', 'SEED_ADMIN_PASSWORD', 'SEED_SRE_PASSWORD', 'SEED_VIEWER_PASSWORD');
  await connectDb();
  console.log(`[seed] connected to ${mongoose.connection.name}`);

  await syncIndexes();

  for (const u of USERS) {
    const passwordHash = await bcrypt.hash(u.pw(), 10);
    await UserModel.updateOne(
      { email: u.email },
      { $set: { name: u.name, role: u.role, teams: [...u.teams], passwordHash } },
      { upsert: true },
    );
  }
  console.log(`[seed] users: ${USERS.map((u) => `${u.email} (${u.role})`).join(', ')}`);

  const keyHash = hashAgentKey(config.simKey);
  await AgentModel.bulkWrite(
    REGIONS.map((r) => ({
      updateOne: {
        filter: { agentId: agentIdForRegion(r.id) },
        update: {
          $set: {
            keyHash,
            name: `Simulator ${r.id}`,
            nodePrefix: r.id,
            ratePerSec: SIM_AGENT_RATE,
            burst: SIM_AGENT_BURST,
            enabled: true,
          },
        },
        upsert: true,
      },
    })),
  );
  console.log(`[seed] agents: ${REGIONS.map((r) => agentIdForRegion(r.id)).join(', ')}`);

  const fleet = buildFleet();
  await NodeModel.bulkWrite(
    fleet.map((n) => ({
      updateOne: {
        filter: { nodeId: n.nodeId },
        update: {
          $set: { serviceId: n.serviceId, team: n.team, region: n.region, az: n.az },
          $setOnInsert: { firstSeen: new Date(), lastSeen: null },
        },
        upsert: true,
      },
    })),
  );
  console.log(`[seed] nodes: ${fleet.length}`);

  for (const m of ALL_MODELS) {
    const idx = await m.collection.indexes();
    const desc = idx
      .filter((i) => i.name !== '_id_')
      .map((i) => `${JSON.stringify(i.key)}${i.unique ? ' unique' : ''}${i.expireAfterSeconds != null ? ` ttl=${i.expireAfterSeconds}s` : ''}`);
    console.log(`[seed] ${m.collection.collectionName.padEnd(11)} ${desc.join(' · ')}`);
  }
}

main()
  .then(() => console.log('[seed] done'))
  .catch((err) => {
    console.error('[seed] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
