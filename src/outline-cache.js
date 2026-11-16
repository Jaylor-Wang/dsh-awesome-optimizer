/** Bounded LRU of parsed symbols, scoped by session and filesystem backend. */
export class OutlineCache {
  constructor(maxEntries, maxBytes) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
    this.generation = 0;
  }

  get(key, version) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.version !== version) { this.delete(key); return null; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, version, value) {
    this.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8') + Buffer.byteLength(key, 'utf8') + Buffer.byteLength(version, 'utf8');
    if (!this.maxEntries || bytes > this.maxBytes) return;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.delete(this.entries.keys().next().value);
    this.entries.set(key, { version, value, bytes });
    this.bytes += bytes;
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  clear() { this.entries.clear(); this.bytes = 0; this.generation++; }
}
