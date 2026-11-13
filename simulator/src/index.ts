import { buildFleet } from '@epicenter/shared';

// Implemented in task A3 (world, agent) and A8 (chaos). Also exported for embedded mode.
export async function startSimulator(_opts: { url: string; hz: number }): Promise<void> {
  throw new Error('simulator not implemented yet (task A3)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`[sim] not implemented yet (task A3); fleet has ${buildFleet().length} nodes`);
}
