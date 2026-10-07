/**
 * Deterministic seeded PRNG (mulberry32). Every run stores its seed so
 * demo-mode executions — and replays — reproduce exactly.
 */
export type Rng = {
  /** float in [0, 1) */
  next(): number;
  /** int in [0, n) */
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
};

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (n) => Math.floor(next() * n),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    shuffle: <T,>(items: readonly T[]): T[] => {
      const arr = [...items];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
      }
      return arr;
    },
  };
  return rng;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
