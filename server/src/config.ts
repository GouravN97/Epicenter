import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// .env lives in the repo root so server, simulator, seed and stress share one file.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const str = (name: string, fallback = ''): string => process.env[name]?.trim() || fallback;
const bool = (name: string): boolean => /^(1|true|yes)$/i.test(str(name));

export const config = {
  port: Number(str('PORT', '4000')),
  mongodbUri: str('MONGODB_URI'),
  jwtSecret: str('JWT_SECRET'),
  clientOrigin: str('CLIENT_ORIGIN', 'http://localhost:5173'),
  simKey: str('SIM_KEY'),
  embeddedSim: bool('EMBEDDED_SIM'),
  seedPasswords: {
    admin: str('SEED_ADMIN_PASSWORD'),
    sre: str('SEED_SRE_PASSWORD'),
    viewer: str('SEED_VIEWER_PASSWORD'),
  },
  isProd: process.env.NODE_ENV === 'production',
} as const;

/** Throws with a readable message when a required variable is missing. Call where the value is first needed. */
export function requireEnv(...names: (keyof typeof process.env)[]): void {
  const missing = names.filter((n) => !process.env[n as string]?.trim());
  if (missing.length) throw new Error(`Missing required env: ${missing.join(', ')} (see .env.example)`);
}
