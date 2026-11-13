import mongoose from 'mongoose';
import { config, requireEnv } from '../config';
import { ALL_MODELS } from './models';

export async function connectDb(): Promise<typeof mongoose> {
  requireEnv('MONGODB_URI');
  mongoose.set('strictQuery', true);
  // Indexes are built explicitly (syncIndexes in seed, ensureIndexes on boot), not lazily per model.
  await mongoose.connect(config.mongodbUri, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  return mongoose;
}

/** Creates any missing indexes. Cheap when they already exist. Does not drop extra indexes. */
export async function ensureIndexes(): Promise<void> {
  await Promise.all(ALL_MODELS.map((m) => m.createIndexes()));
}

/** Makes the database indexes match the schemas exactly (drops stale ones). Used by the seed script. */
export async function syncIndexes(): Promise<void> {
  for (const m of ALL_MODELS) await m.syncIndexes();
}

export const disconnectDb = (): Promise<void> => mongoose.disconnect();
