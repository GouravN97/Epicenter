import { describe, expect, it } from 'vitest';
import { NAV_KEYS, SHORTCUT_GROUPS, isTyping, pickControl, resolveKey, shortcutKey, shortcutsFor } from './shortcuts';

const el = (attrs: Record<string, string>) => ({ getAttribute: (n: string) => attrs[n] ?? null });

describe('shortcutKey', () => {
  it('lowercases single characters and ignores everything else', () => {
    expect(shortcutKey({ key: 'G' })).toBe('g');
    expect(shortcutKey({ key: '?' })).toBe('?');
    expect(shortcutKey({ key: '3' })).toBe('3');
    expect(shortcutKey({ key: 'Enter' })).toBeNull();
    expect(shortcutKey({ key: ' ' })).toBeNull();
  });
  it('leaves browser and system combinations alone', () => {
    expect(shortcutKey({ key: 'r', ctrlKey: true })).toBeNull();
    expect(shortcutKey({ key: 'l', metaKey: true })).toBeNull();
    expect(shortcutKey({ key: 'd', altKey: true })).toBeNull();
  });
});

describe('isTyping', () => {
  it('is true in text fields and false on buttons and sliders', () => {
    expect(isTyping({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTyping({ tagName: 'SELECT' })).toBe(true);
    expect(isTyping({ tagName: 'INPUT', getAttribute: () => null })).toBe(true);
    expect(isTyping({ tagName: 'INPUT', getAttribute: () => 'password' })).toBe(true);
    expect(isTyping({ tagName: 'INPUT', getAttribute: () => 'range' })).toBe(false);
    expect(isTyping({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTyping({ tagName: 'BUTTON' })).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe('resolveKey', () => {
  const routes = ['/', '/topology', '/incidents', '/pipeline']; // not an admin: no /chaos
  it('reads g then a letter as navigation, only to pages the user has', () => {
    expect(resolveKey('g', false, routes)).toEqual({ kind: 'prefix' });
    expect(resolveKey('t', true, routes)).toEqual({ kind: 'nav', to: '/topology' });
    expect(resolveKey('o', true, routes)).toEqual({ kind: 'nav', to: '/' });
    expect(resolveKey('c', true, routes)).toEqual({ kind: 'none' });
    expect(resolveKey('c', true, [...routes, '/chaos'])).toEqual({ kind: 'nav', to: '/chaos' });
    expect(resolveKey('z', true, routes)).toEqual({ kind: 'none' });
  });
  it('reads the same letters as page controls without the g', () => {
    expect(resolveKey('t', false, routes)).toEqual({ kind: 'control', key: 't' });
    expect(resolveKey('?', false, routes)).toEqual({ kind: 'help' });
    expect(resolveKey('d', false, routes)).toEqual({ kind: 'display' });
  });
});

describe('pickControl', () => {
  it('toggles between a pair of tabs', () => {
    const active = el({ 'aria-selected': 'true' });
    const all = el({ 'aria-selected': 'false' });
    expect(pickControl([active, all])).toBe(all);
  });
  it('does nothing when the only match is already chosen', () => {
    expect(pickControl([el({ 'aria-checked': 'true' })])).toBeNull();
    expect(pickControl([])).toBeNull();
  });
  it('takes a plain button as it is', () => {
    const b = el({});
    expect(pickControl([b])).toBe(b);
  });
});

describe('the list', () => {
  it('has a distinct key for every page', () => {
    const keys = Object.values(NAV_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('hides the Chaos Lab shortcut from non-admins', () => {
    const has = (role: 'admin' | 'viewer') => shortcutsFor(role).some((g) => g.items.some((s) => s.keys === 'g c'));
    expect(has('admin')).toBe(true);
    expect(has('viewer')).toBe(false);
  });
  it('has no duplicate keys within a group', () => {
    for (const g of SHORTCUT_GROUPS) {
      const keys = g.items.map((s) => s.keys);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
