import { describe, expect, it } from "vitest";
import { mapLimit } from "./concurrency.js";

/** A promise that the test resolves or rejects, to control the order of completion. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** Lets the started workers continue until they wait again. */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

/** Runs `values` and reports how many workers were in flight at the same time. */
async function measure<T>(values: T[], limit: number): Promise<{ peak: number; calls: number; result: T[] }> {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const result = await mapLimit(values, limit, async (value) => {
    calls += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return value;
  });
  return { peak, calls, result };
}

describe("mapLimit", () => {
  it("preserves input order when the workers complete out of order", async () => {
    const values = ["a", "b", "c", "d"];
    const gates = values.map(() => deferred<string>());
    const started: string[] = [];
    const result = mapLimit(values, 2, async (value) => {
      const index = values.indexOf(value);
      started.push(value);
      return gates[index]!.promise;
    });

    // The limit holds two values in flight. Thus each later value starts only
    // when an earlier one completes, and one worker takes more than one index.
    await flush();
    expect(started).toEqual(["a", "b"]);
    gates[1]!.resolve("B");
    await flush();
    expect(started).toEqual(["a", "b", "c"]);
    gates[0]!.resolve("A");
    await flush();
    expect(started).toEqual(["a", "b", "c", "d"]);
    gates[3]!.resolve("D");
    gates[2]!.resolve("C");

    // The values completed in the order b, a, d, c.
    expect(await result).toEqual(["A", "B", "C", "D"]);
  });

  it("rejects as soon as one worker rejects, without waiting for the others", async () => {
    const slow = deferred<string>();
    const result = mapLimit(["fails", "never settles"], 2, async (value) => {
      if (value === "fails") throw new Error("worker failed");
      return slow.promise;
    });
    // `slow` stays unsettled for the whole test. Thus the test completes only if
    // the rejection appears before the other worker finishes.
    await expect(result).rejects.toThrow("worker failed");
  });

  it("keeps at most the given number of workers in flight", async () => {
    const { peak, result } = await measure([1, 2, 3, 4, 5, 6], 2);
    expect(peak).toBe(2);
    expect(result).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("runs each value once when the limit is larger than the input", async () => {
    const { peak, calls, result } = await measure(["a", "b", "c"], 100);
    expect(peak).toBe(3);
    expect(calls).toBe(3);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("runs one at a time when the limit is below one", async () => {
    const { peak, result } = await measure([1, 2, 3], 0);
    expect(peak).toBe(1);
    expect(result).toEqual([1, 2, 3]);
  });

  it("returns nothing for an empty input without calling the worker", async () => {
    const { calls, result } = await measure([], 4);
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });
});
