// T3 / §I — bounded ring queue for high-frequency gameplay events + commands.
// Bounded: fixed capacity, never grows in a hot path. The backing array is reused every frame
// (no per-frame allocation). Overflow is explicit (push returns false) — never a silent drop
// disguised as success (V4 spirit: no silent fallbacks).

export class RingQueue<T> {
  private readonly slots: (T | undefined)[];
  private readonly cap: number;
  private head = 0;
  private tail = 0;
  private count = 0;
  private _overflowCount = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingQueue capacity must be a positive integer, got ${capacity}`);
    }
    this.cap = capacity;
    this.slots = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.cap;
  }

  /** Number of pushes rejected due to fullness since construction (diagnostics). */
  get overflowCount(): number {
    return this._overflowCount;
  }

  /** Enqueue. Returns false (and records overflow) when full. */
  push(item: T): boolean {
    if (this.count === this.cap) {
      this._overflowCount += 1;
      return false;
    }
    this.slots[this.tail] = item;
    this.tail = (this.tail + 1) % this.cap;
    this.count += 1;
    return true;
  }

  /** Dequeue one item, or undefined if empty. Clears the slot so refs aren't retained. */
  pop(): T | undefined {
    if (this.count === 0) return undefined;
    const item = this.slots[this.head];
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.cap;
    this.count -= 1;
    return item;
  }

  /** Drain all queued items in FIFO order into the handler. */
  drain(handler: (item: T) => void): void {
    let item = this.pop();
    while (item !== undefined) {
      handler(item);
      item = this.pop();
    }
  }

  clear(): void {
    while (this.pop() !== undefined) {
      /* slots cleared by pop */
    }
  }
}
