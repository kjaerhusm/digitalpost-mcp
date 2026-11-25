/** Compare two timestamps by parsed instant, not by string order. */
export function compareInstants(left: string, right: string): number {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return left.localeCompare(right);
  return a - b;
}
