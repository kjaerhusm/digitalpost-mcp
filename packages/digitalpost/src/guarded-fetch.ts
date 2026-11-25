import { assertEboksMailRead } from './eboks-guard.ts';
import { assertMailRead } from './guard.ts';

/**
 * The only `fetch(` in this package. Every other caller goes through here
 * or through the MitID HttpClient, both of which run the read-only guard.
 */
export async function guardedFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  assertMailRead(method, url);
  assertEboksMailRead(method, url);
  return fetch(url, init);
}
