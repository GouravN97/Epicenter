import { describe, expect, it } from 'vitest';
import { initialTour, parseSavedTour } from './tourStore';

const IDS = ['welcome', 'tiles', 'done'];

describe('parseSavedTour', () => {
  it('treats nothing or rubbish as never seen', () => {
    expect(parseSavedTour(null)).toBeNull();
    expect(parseSavedTour('not json')).toBeNull();
    expect(parseSavedTour('null')).toBeNull();
  });
  it('reads a saved record', () => {
    expect(parseSavedTour('{"done":true,"step":null}')).toEqual({ done: true, step: null });
    expect(parseSavedTour('{"done":false,"step":"tiles"}')).toEqual({ done: false, step: 'tiles' });
    expect(parseSavedTour('{"step":7}')).toEqual({ done: false, step: null });
  });
});

describe('initialTour', () => {
  it('opens at the first step for an account that has never seen it', () => {
    expect(initialTour(null, IDS)).toEqual({ status: 'open', stepId: 'welcome' });
  });
  it('stays off once finished', () => {
    expect(initialTour({ done: true, step: null }, IDS)).toEqual({ status: 'off', stepId: null });
  });
  it('offers to resume where it was left', () => {
    expect(initialTour({ done: false, step: 'tiles' }, IDS)).toEqual({ status: 'min', stepId: 'tiles' });
  });
  it('resumes from the start when the saved step is not one this role has', () => {
    expect(initialTour({ done: false, step: 'cpu-start' }, IDS)).toEqual({ status: 'min', stepId: 'welcome' });
  });
});
