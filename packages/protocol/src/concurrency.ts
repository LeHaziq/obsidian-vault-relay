/**
 * Runs `run` over `values` with at most `concurrency` in flight, preserving
 * input order in the result. Rejects as soon as any worker rejects.
 */
export async function mapLimit<T, R>(values: T[], concurrency: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  const limit = Math.min(Math.max(1, Math.floor(concurrency) || 1), values.length);
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      result[index] = await run(values[index]!);
    }
  });
  await Promise.all(workers);
  return result;
}
