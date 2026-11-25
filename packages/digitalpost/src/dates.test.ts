import { describe, expect, test } from 'bun:test';
import { datesFromLetter, detectDatesInText } from './dates.ts';

describe('Danish date heuristics', () => {
  test('reads an appointment with a clock time and a place', () => {
    const dates = detectDatesInText(
      'Indkaldelse til undersøgelse den 15. marts 2026 kl. 10:30 på Rigshospitalet',
      'subject',
      '2026-03-01T00:00:00Z',
    );
    expect(dates).toEqual([
      expect.objectContaining({
        kind: 'appointment',
        date: '2026-03-15',
        time: '10:30',
        place: 'Rigshospitalet',
        source: 'subject',
        heuristic: true,
      }),
    ]);
  });

  test('reads a deadline and a numeric date', () => {
    const dates = detectDatesInText(
      'Svar senest den 1. april 2026. Betal inden 02-04-2026.',
      'pdf',
      '2026-03-01T00:00:00Z',
    );
    expect(dates.map((date) => date.date)).toEqual(['2026-04-02', '2026-04-01']);
    expect(dates.every((date) => date.kind === 'deadline')).toBe(true);
  });

  test('keeps a written clock time instead of converting it', () => {
    const dates = detectDatesInText('Møde 15/3-2026 kl. 09.00', 'subject', null);
    expect(dates[0]).toEqual(
      expect.objectContaining({ kind: 'appointment', date: '2026-03-15', time: '09:00' }),
    );
  });

  test('rolls a month-only date that is already past the letter into the next year', () => {
    const dates = detectDatesInText('Fremmøde den 2. januar', 'subject', '2026-03-20T00:00:00Z');
    expect(dates[0]?.date).toBe('2027-01-02');
    expect(dates[0]?.heuristic).toBe(true);
  });

  test('copies replyBy from the gateway as a non-heuristic deadline', () => {
    const dates = datesFromLetter({
      subject: 'Ejendomsskat',
      receivedAt: '2026-03-02T09:15:00Z',
      replyBy: '2026-04-01T00:00:00Z',
      pdfText: null,
    });
    expect(dates).toEqual([
      expect.objectContaining({
        source: 'replyBy',
        date: '2026-04-01',
        time: '02:00',
        heuristic: false,
        kind: 'deadline',
      }),
    ]);
  });

  test('uses the Copenhagen calendar day for a local midnight deadline', () => {
    const dates = datesFromLetter({
      subject: null,
      receivedAt: null,
      replyBy: '2026-03-31T22:00:00Z',
    });
    expect(dates[0]).toEqual(
      expect.objectContaining({
        source: 'replyBy',
        date: '2026-04-01',
        time: null,
        heuristic: false,
      }),
    );
  });
});
