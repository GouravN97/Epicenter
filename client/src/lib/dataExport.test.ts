import { describe, expect, it } from 'vitest';
import type { AlertDTO } from '@epicenter/shared';
import { buildAlertsExport, buildSeriesExport, exportFilename, filterAlertsByMetric, parseMetricSelection, toggleMetric } from './dataExport';

const NOW = Date.UTC(2026, 10, 14, 21, 57, 0);

describe('metric selection', () => {
  const fallback = ['cpu', 'mem'] as const;
  it('falls back when nothing usable is stored', () => {
    expect(parseMetricSelection(null, fallback)).toEqual(['cpu', 'mem']);
    expect(parseMetricSelection('nope', fallback)).toEqual(['cpu', 'mem']);
    expect(parseMetricSelection('[]', fallback)).toEqual(['cpu', 'mem']);
    expect(parseMetricSelection('["bogus"]', fallback)).toEqual(['cpu', 'mem']);
  });
  it('keeps known metrics in the canonical order', () => {
    expect(parseMetricSelection('["rps","cpu","bogus"]', fallback)).toEqual(['cpu', 'rps']);
  });
  it('toggles, in order, and never empties', () => {
    expect(toggleMetric(['cpu', 'lat'], 'mem')).toEqual(['cpu', 'mem', 'lat']);
    expect(toggleMetric(['cpu', 'lat'], 'cpu')).toEqual(['lat']);
    expect(toggleMetric(['lat'], 'lat')).toEqual(['lat']);
  });
});

describe('buildSeriesExport', () => {
  const node = { id: 'us-east-1a.db.01', service: 'db', team: 'data', region: 'us-east-1', az: 'us-east-1a' };
  const data = { cpu: Float32Array.from([41.123456, NaN]), lat: Float32Array.from([12.5, 13]) };
  const out = buildSeriesExport({
    node,
    resolution: '1s',
    rangeLabel: '5 m',
    metrics: ['cpu', 'lat'],
    times: Float64Array.from([NOW - 1000, NOW]),
    column: (m) => data[m as 'cpu' | 'lat'],
    now: NOW,
  });
  it('has one row per point with only the chosen metrics', () => {
    expect(out.points).toHaveLength(2);
    expect(Object.keys(out.points[0]!)).toEqual(['t', 'time', 'cpu', 'lat']);
    expect(out.points[0]).toMatchObject({ t: NOW - 1000, time: '2026-11-14T21:56:59.000Z', cpu: 41.12, lat: 12.5 });
  });
  it('writes gaps as null, so the file is valid JSON', () => {
    expect(out.points[1]!.cpu).toBeNull();
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });
  it('describes itself', () => {
    expect(out.metrics).toEqual([
      { name: 'cpu', label: 'CPU', unit: '%' },
      { name: 'lat', label: 'Latency', unit: 'ms' },
    ]);
    expect(out.range).toEqual({ label: '5 m', from: '2026-11-14T21:56:59.000Z', to: '2026-11-14T21:57:00.000Z' });
    expect(out.exportedAt).toBe('2026-11-14T21:57:00.000Z');
  });
  it('copes with no data', () => {
    const empty = buildSeriesExport({ node, resolution: '1m', rangeLabel: '6 h', metrics: ['cpu'], times: [], column: () => [], now: NOW });
    expect(empty.points).toEqual([]);
    expect(empty.range.from).toBeNull();
  });
});

describe('alerts', () => {
  const alert = (over: Partial<AlertDTO>) => ({ id: 'a', metric: 'cpu', startedAt: NOW - 5000, resolvedAt: null, ...over }) as AlertDTO;
  const list = [alert({ id: '1' }), alert({ id: '2', metric: 'lat', resolvedAt: NOW })];
  it('filters by metric', () => {
    expect(filterAlertsByMetric(list, 'all')).toHaveLength(2);
    expect(filterAlertsByMetric(list, 'lat').map((a) => a.id)).toEqual(['2']);
    expect(filterAlertsByMetric(list, 'mem')).toEqual([]);
  });
  it('exports what is shown, with readable times', () => {
    const out = buildAlertsExport(list, { state: 'all', metric: 'all' }, NOW);
    expect(out.count).toBe(2);
    expect(out.alerts[0]!.startedTime).toBe('2026-11-14T21:56:55.000Z');
    expect(out.alerts[0]!.resolvedTime).toBeNull();
    expect(out.alerts[1]!.resolvedTime).toBe('2026-11-14T21:57:00.000Z');
  });
});

describe('exportFilename', () => {
  it('is dated and filesystem-safe', () => {
    expect(exportFilename('us-east-1a.db.01', NOW)).toBe('epicenter-us-east-1a.db.01-20261114-215700.json');
    expect(exportFilename('alerts cpu/all', NOW)).toBe('epicenter-alerts-cpu-all-20261114-215700.json');
  });
});
