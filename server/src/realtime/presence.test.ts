import { describe, expect, it } from 'vitest';
import { Presence } from './presence';

const ada = { id: 'u1', name: 'Ada' };
const bob = { id: 'u2', name: 'Bob' };

describe('Presence', () => {
  it('lists users per incident, one entry per user across tabs, sorted by name', () => {
    const p = new Presence();
    p.join('i1', 's1', bob);
    p.join('i1', 's2', ada);
    expect(p.join('i1', 's3', ada)).toEqual([ada, bob]); // Ada's second tab
    expect(p.users('i2')).toEqual([]);
  });

  it('a user stays present until their last tab leaves', () => {
    const p = new Presence();
    p.join('i1', 's1', ada);
    p.join('i1', 's2', ada);
    expect(p.leave('i1', 's1')).toEqual([ada]);
    expect(p.leave('i1', 's2')).toEqual([]);
    expect(p.leave('i1', 's2')).toBeNull(); // not present: nothing to announce
  });

  it('leaveAll reports every incident the socket was in', () => {
    const p = new Presence();
    p.join('i1', 's1', ada);
    p.join('i2', 's1', ada);
    p.join('i2', 's2', bob);
    expect(p.leaveAll('s1').sort()).toEqual(['i1', 'i2']);
    expect(p.users('i2')).toEqual([bob]);
  });
});
