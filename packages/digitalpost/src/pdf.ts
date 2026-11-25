import { DigitalPostError } from './errors.ts';

const MAX_CHARS = 100_000;

/**
 * Extract text from a PDF so an agent can read a letter.
 * The text is returned to the caller and is not logged.
 */
export async function extractPdfText(
  bytes: Uint8Array,
): Promise<{ text: string; truncated: boolean; pages: number }> {
  if (bytes.byteLength < 5 || !looksLikePdf(bytes)) {
    throw new DigitalPostError('That file is not a PDF, so there is no text to extract.');
  }
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const extracted = await extractText(pdf, { mergePages: true });
  const raw = Array.isArray(extracted.text) ? extracted.text.join('\n\n') : extracted.text;
  const text = raw.trim();
  if (text.length <= MAX_CHARS) {
    return { text, truncated: false, pages: extracted.totalPages };
  }
  return { text: text.slice(0, MAX_CHARS), truncated: true, pages: extracted.totalPages };
}

function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 5));
  return head.startsWith('%PDF');
}
