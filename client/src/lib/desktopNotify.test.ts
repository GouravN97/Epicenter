import { describe, expect, it } from 'vitest';
import type { IncidentDTO } from '@epicenter/shared';
import { notificationContent, resolveNotifyStatus } from './desktopNotify';

const incident = (over: Partial<IncidentDTO> = {}): IncidentDTO => ({
  id: 'abc123',
  title: 'db: threshold/lat — 4 services affected',
  state: 'open',
  epicenter: 'db',
  confidence: 1,
  affected: ['db', 'auth', 'orders-api', 'edge-gateway'],
  blastRadius: [],
  startedAt: 0,
  endedAt: null,
  ...over,
});

describe('desktop notifications', () => {
  it('names the epicenter and links to the incident room', () => {
    expect(notificationContent(incident())).toEqual({
      title: 'New incident: Database',
      body: 'db: threshold/lat — 4 services affected\n4 services alerting. Click to open the incident room.',
      tag: 'epicenter-incident-abc123',
      to: '/incidents/abc123',
    });
  });

  it('still reads well before the epicenter is known, and for one service', () => {
    const c = notificationContent(incident({ epicenter: null, title: '', affected: ['payments'] }));
    expect(c.title).toBe('New incident');
    expect(c.body).toBe('Alerts are being correlated. 1 service alerting.');
  });

  it('is on only when the user asked for it and the browser still allows it', () => {
    expect(resolveNotifyStatus(false, null, true)).toBe('unsupported');
    expect(resolveNotifyStatus(true, 'denied', true)).toBe('blocked');
    expect(resolveNotifyStatus(true, 'granted', true)).toBe('on');
    expect(resolveNotifyStatus(true, 'granted', false)).toBe('off');
    expect(resolveNotifyStatus(true, 'default', true)).toBe('off'); // permission was reset in the browser
  });
});
