import { describe, expect, it } from 'vitest';
import { parseOrigins } from './config';

describe('parseOrigins', () => {
  it('splits a comma-separated list, trims it and drops trailing slashes and duplicates', () => {
    expect(parseOrigins(' https://epicenter.vercel.app/ , http://localhost:5173,https://epicenter.vercel.app')).toEqual([
      'https://epicenter.vercel.app',
      'http://localhost:5173',
    ]);
  });

  it('falls back to the local client when nothing is set', () => {
    expect(parseOrigins('')).toEqual(['http://localhost:5173']);
    expect(parseOrigins(' , ')).toEqual(['http://localhost:5173']);
  });
});
