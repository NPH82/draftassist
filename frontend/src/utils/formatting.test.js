import { describe, it, expect, vi } from 'vitest';
import { timeAgo, formatEta, dasClass, winWindowColor } from './formatting';

describe('formatting utilities', () => {
  it('timeAgo returns unknown for empty input', () => {
    expect(timeAgo(null)).toBe('unknown');
  });

  it('timeAgo returns just now for under one minute', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 20 * 1000))).toBe('just now');
  });

  it('timeAgo returns minutes, hours, and days', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 5 * 60 * 1000))).toBe('5m ago');
    expect(timeAgo(new Date(now - 3 * 60 * 60 * 1000))).toBe('3h ago');
    expect(timeAgo(new Date(now - 2 * 24 * 60 * 60 * 1000))).toBe('2d ago');
  });

  it('formatEta returns placeholders and formatted durations', () => {
    expect(formatEta(null)).toBe('--');

    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    expect(formatEta(base - 1)).toBe('Now');
    expect(formatEta(base + 30 * 1000)).toBe('<1m');
    expect(formatEta(base + 12 * 60 * 1000)).toBe('~12m');
    expect(formatEta(base + 2 * 60 * 60 * 1000)).toBe('~2h');

    vi.useRealTimers();
  });

  it('dasClass buckets high/mid/low', () => {
    expect(dasClass(80)).toBe('das-high');
    expect(dasClass(50)).toBe('das-mid');
    expect(dasClass(10)).toBe('das-low');
  });

  it('winWindowColor maps known labels and default', () => {
    expect(winWindowColor('Built To Win')).toBe('text-green');
    expect(winWindowColor('Sustainable Contender')).toBe('text-green');
    expect(winWindowColor('Aging Contender')).toBe('text-yellow');
    expect(winWindowColor('Contending')).toBe('text-accent');
    expect(winWindowColor('Re-Tooling')).toBe('text-yellow');
    expect(winWindowColor('Anything Else')).toBe('text-secondary');
  });
});
