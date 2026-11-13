import { createHash } from 'node:crypto';

/**
 * Agent keys are high-entropy secrets, so a fast sha256 is enough and lets the ingest path find an agent by
 * hash (bcrypt hashes are salted and cannot be looked up). User passwords use bcrypt.
 */
export const hashAgentKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');
