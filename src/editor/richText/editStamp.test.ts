import { describe, expect, it } from 'vitest';
import { stampTextEdit, TEXT_EDIT_STAMP_INTERVAL_MS } from './editStamp';

const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('stampTextEdit', () => {
  it('moves a page last changed minutes ago to now', () => {
    const page = { createdAt: iso(T0 - 3_600_000), updatedAt: iso(T0 - 6 * 60_000) };
    stampTextEdit(page, T0);
    expect(page.updatedAt).toBe(iso(T0));
  });

  it('does not stamp on every keystroke', () => {
    const page = { createdAt: iso(T0 - 3_600_000), updatedAt: iso(T0 - 1_000) };
    stampTextEdit(page, T0);
    expect(page.updatedAt).toBe(iso(T0 - 1_000));
    stampTextEdit(page, T0 - 1_000 + TEXT_EDIT_STAMP_INTERVAL_MS);
    expect(page.updatedAt).toBe(iso(T0 - 1_000 + TEXT_EDIT_STAMP_INTERVAL_MS));
  });

  it('always stamps the first edit of an untouched page, even within the creating second', () => {
    const page = { createdAt: iso(T0), updatedAt: iso(T0) };
    stampTextEdit(page, T0 + 300);
    expect(page.updatedAt).not.toBe(page.createdAt);
    const sameMillisecond = { createdAt: iso(T0), updatedAt: iso(T0) };
    stampTextEdit(sameMillisecond, T0);
    expect(sameMillisecond.updatedAt).not.toBe(sameMillisecond.createdAt);
  });

  it('replaces a time in the future (a clock that was off) and an unreadable one', () => {
    const future = { createdAt: iso(T0 - 1_000), updatedAt: iso(T0 + 3_600_000) };
    stampTextEdit(future, T0);
    expect(future.updatedAt).toBe(iso(T0));
    const broken = { createdAt: 'x', updatedAt: 'not a date' };
    stampTextEdit(broken, T0);
    expect(broken.updatedAt).toBe(iso(T0));
  });
});
