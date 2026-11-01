// A Map of integer keys to state indices in two typed arrays (open addressing, linear probing). Hermes makes each
// Map entry an object of its own: a long route's alternatives settled 717,000 search states, tens of MB of entries
// the JS heap grew by and kept (iOS, 2026-11-01). Here they are 12 bytes a slot.

const EMPTY = -1;
const TWO_32 = 4294967296;

export class KeyIndex {
  private keys: Float64Array;
  private values: Int32Array;
  private mask: number;
  size = 0;

  /** `capacity`: keys expected before the first growth. */
  constructor(capacity = 4096) {
    let slots = 16;
    while (slots < 2 * capacity) slots *= 2;
    this.keys = new Float64Array(slots).fill(EMPTY);
    this.values = new Int32Array(slots);
    this.mask = slots - 1;
  }

  /** The value of `key` (a non-negative integer below 2^53), −1 without one. */
  get(key: number): number {
    const keys = this.keys;
    for (let i = slot(key) & this.mask; ; i = (i + 1) & this.mask) {
      const k = keys[i];
      if (k === key) return this.values[i];
      if (k === EMPTY) return -1;
    }
  }

  set(key: number, value: number): void {
    if (2 * (this.size + 1) > this.keys.length) this.grow();
    const keys = this.keys;
    for (let i = slot(key) & this.mask; ; i = (i + 1) & this.mask) {
      const k = keys[i];
      if (k === key) {
        this.values[i] = value;
        return;
      }
      if (k === EMPTY) {
        keys[i] = key;
        this.values[i] = value;
        this.size++;
        return;
      }
    }
  }

  private grow(): void {
    const { keys, values } = this;
    this.keys = new Float64Array(2 * keys.length).fill(EMPTY);
    this.values = new Int32Array(2 * keys.length);
    this.mask = this.keys.length - 1;
    this.size = 0;
    for (let i = 0; i < keys.length; i++) if (keys[i] !== EMPTY) this.set(keys[i], values[i]);
  }
}

/** Both 32-bit halves of the key, mixed (graph ids pass 2^32: a tile number times 65,536). */
function slot(key: number): number {
  const lo = key >>> 0;
  const hi = Math.floor(key / TWO_32);
  return Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b) ^ (lo >>> 15);
}
