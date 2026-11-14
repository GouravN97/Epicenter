import { describe, expect, it } from 'vitest';
import { DISPLAY_MODES, parseDisplayMode, resolveScheme } from './displayStore';

describe('display mode', () => {
  it('falls back to the control room for anything it does not recognise', () => {
    expect(parseDisplayMode('glass')).toBe('glass');
    expect(parseDisplayMode('control')).toBe('control');
    expect(parseDisplayMode(null)).toBe('control');
    expect(parseDisplayMode('GLASS')).toBe('control');
    expect(parseDisplayMode(42)).toBe('control');
  });

  it('every listed mode survives a round trip through storage', () => {
    for (const m of DISPLAY_MODES) expect(parseDisplayMode(m.id)).toBe(m.id);
  });

  it('keeps the control room dark and lets Glass follow the system', () => {
    expect(resolveScheme('control', false)).toBe('dark');
    expect(resolveScheme('control', true)).toBe('dark');
    expect(resolveScheme('glass', false)).toBe('light');
    expect(resolveScheme('glass', true)).toBe('dark');
  });
});
