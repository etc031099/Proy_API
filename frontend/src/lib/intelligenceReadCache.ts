export interface IntelligenceRevision {
  businessId: string;
  scenarioId: string;
  datasetVersion: string;
  asOf: string;
  dataVersion: string;
}

/** Memory-only, session-owned reads. Every reuse requires a successful server revision read. */
export class IntelligenceReadCache {
  private entries = new Map<string, unknown>();
  private pending = new Map<string, Promise<unknown>>();
  private revisionPending: Promise<IntelligenceRevision> | null = null;
  private stamp = '';
  private generation = 0;

  constructor(private revision: () => Promise<IntelligenceRevision>) {}

  clear() { this.entries.clear(); this.pending.clear(); this.revisionPending = null; this.stamp = ''; this.generation++; }

  private async current() {
    if (!this.revisionPending) {
      const task = this.revision();
      this.revisionPending = task;
      void task.finally(() => { if (this.revisionPending === task) this.revisionPending = null; }).catch(() => {});
    }
    const value = await this.revisionPending;
    if (!value.businessId || !value.scenarioId || !value.datasetVersion || !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf)
      || !/^\d+$/.test(value.dataVersion)) throw new Error('Invalid intelligence revision');
    return JSON.stringify([value.businessId, value.scenarioId, value.datasetVersion, value.asOf, value.dataVersion]);
  }

  read<T>(queryKey: string, load: () => Promise<T>, versioned = true): Promise<T> {
    const key = JSON.stringify([versioned, queryKey]);
    const pending = this.pending.get(key);
    if (pending) return pending.then(value => structuredClone(value)) as Promise<T>;
    const generation = this.generation;
    const task = (async () => {
      try {
        // Frozen artifacts retain their existing availability before LIVE bootstrap.
        // Without an artifact-version probe, deduplicate only; do not retain completed responses.
        if (!versioned) {
          const result = await load();
          if (generation !== this.generation) throw new Error('Intelligence session changed');
          return result;
        }
        const stamp = await this.current();
        if (generation !== this.generation) throw new Error('Intelligence session changed');
        if (this.stamp !== stamp) { this.entries.clear(); this.stamp = stamp; }
        const cacheKey = JSON.stringify([stamp, key]);
        if (this.entries.has(cacheKey)) return this.entries.get(cacheKey) as T;
        const result = await load();
        // Covers endpoints without revision metadata too; never label an old response as current.
        const after = await this.current();
        if (generation !== this.generation) throw new Error('Intelligence session changed');
        if (stamp !== after) throw new Error('Intelligence revision changed');
        const envelope = result as { success?: boolean; data?: unknown };
        if (envelope.success && envelope.data != null) {
          this.entries.set(cacheKey, structuredClone(result));
          while (this.entries.size > 40) this.entries.delete(this.entries.keys().next().value!);
        }
        return result;
      } catch (error) { this.entries.clear(); throw error; }
    })();
    this.pending.set(key, task);
    void task.finally(() => { if (this.pending.get(key) === task) this.pending.delete(key); }).catch(() => {});
    return task.then(value => structuredClone(value));
  }
}
