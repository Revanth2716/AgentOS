/** FNV-1a 32-bit hash — fast, deterministic, dependency-free. For digests only. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function truncate(s: string, max = 2_000): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [+${s.length - max} chars]`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
