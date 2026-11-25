import { DigitalPostError } from './errors.ts';

/** Path segments come from tool arguments and cursors. Reject anything that can escape the route. */
export function assertPathSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 200 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    hasControlChar(value)
  ) {
    throw new DigitalPostError(`Refusing an unsafe ${label}.`);
  }
  return value;
}

function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32) return true;
  }
  return false;
}
