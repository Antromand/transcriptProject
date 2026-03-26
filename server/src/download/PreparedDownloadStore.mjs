export class PreparedDownloadStore {
  constructor({ ttlMs = 20 * 60 * 1000, onExpire = async () => {} } = {}) {
    this.ttlMs = ttlMs;
    this.onExpire = onExpire;
    this.entries = new Map();
  }

  set(entry) {
    this.delete(entry.id).catch(() => {});
    const timer = setTimeout(() => {
      const current = this.entries.get(entry.id);
      if (!current) return;
      this.entries.delete(entry.id);
      Promise.resolve(this.onExpire(this.toPublicEntry(current))).catch(() => {});
    }, this.ttlMs);
    if (typeof timer.unref === "function") timer.unref();
    this.entries.set(entry.id, { ...entry, _timer: timer });
    return entry;
  }

  get(id) {
    const entry = this.entries.get(id);
    return entry ? this.toPublicEntry(entry) : null;
  }

  take(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    clearTimeout(entry._timer);
    this.entries.delete(id);
    return this.toPublicEntry(entry);
  }

  async delete(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry._timer);
    this.entries.delete(id);
    await Promise.resolve(this.onExpire(this.toPublicEntry(entry)));
  }

  async dispose(entry) {
    if (!entry) return;
    await Promise.resolve(this.onExpire(entry));
  }

  toPublicEntry(entry) {
    const { _timer, ...rest } = entry;
    return rest;
  }
}
