import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractPdfText } from './pdf.ts';

describe('extractPdfText', () => {
  test('reads the fixture letter', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('../fixtures/hello.pdf', import.meta.url)));
    const extracted = await extractPdfText(bytes);
    expect(extracted.pages).toBe(1);
    expect(extracted.text).toContain('Hello letter');
    expect(extracted.truncated).toBe(false);
  });

  test('rejects a non-pdf', async () => {
    await expect(extractPdfText(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/not a PDF/);
  });
});
