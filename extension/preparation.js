'use strict';

// One debounced job per tab. Only metadata inspection occupies these slots;
// downloads have an independent lifetime. A change during a job schedules one
// follow-up, rather than one inspection for every network request.
class PreparationQueue {
  constructor(run, { delay = 700, limit = 2, changed = () => {} } = {}) {
    this.run = run; this.delay = delay; this.limit = limit; this.changed = changed;
    this.jobs = new Map(); this.running = 0; this.order = 0;
  }
  schedule(tabId, { immediate = false, priority = 0 } = {}) {
    let job = this.jobs.get(tabId);
    if (job?.running) { job.again = true; return job.promise; }
    if (!job) {
      job = { tabId, priority, order: this.order++, controller: new AbortController() };
      job.promise = new Promise(resolve => { job.resolve = resolve; });
      this.jobs.set(tabId, job);
    }
    job.priority = Math.max(job.priority, priority);
    // Do not keep postponing a job on a busy stream.
    if (immediate) { clearTimeout(job.timer); job.due = true; }
    else if (!job.timer && !job.due) job.timer = setTimeout(() => { job.due = true; this.drain(); }, this.delay);
    this.changed(tabId, 'queued');
    this.drain();
    return job.promise;
  }
  drain() {
    while (this.running < this.limit) {
      const job = [...this.jobs.values()].filter(item => item.due && !item.running)
        .sort((a, b) => b.priority - a.priority || a.order - b.order)[0];
      if (!job) return;
      job.running = true; this.running++;
      this.changed(job.tabId, 'analyzing');
      Promise.resolve().then(() => this.run(job.tabId, job.controller.signal)).catch(() => {}).finally(() => {
        this.running--; job.resolve();
        if (this.jobs.get(job.tabId) === job) {
          this.jobs.delete(job.tabId);
          if (job.again) this.schedule(job.tabId, { priority: job.priority });
        }
        this.drain();
      });
    }
  }
  cancel(tabId) {
    const job = this.jobs.get(tabId);
    if (!job) return;
    this.jobs.delete(tabId); clearTimeout(job.timer); job.controller.abort(); job.resolve();
  }
  clear() { for (const id of this.jobs.keys()) this.cancel(id); }
}

// Shared by manual and automatic inspections, including requests started while
// another tab is preparing. Cancellation removes queued work before it spawns.
class InspectionSlots {
  constructor(limit = 2) { this.limit = limit; this.running = 0; this.waiting = []; }
  async use(work, signal) {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const item = { resolve, reject, signal };
      item.abort = () => { this.waiting = this.waiting.filter(value => value !== item); reject(signal.reason); };
      signal?.addEventListener('abort', item.abort, { once: true });
      this.waiting.push(item); this.drain();
    });
    try { signal?.throwIfAborted(); return await work(); }
    finally { this.running--; this.drain(); }
  }
  drain() {
    while (this.running < this.limit && this.waiting.length) {
      const item = this.waiting.shift();
      item.signal?.removeEventListener('abort', item.abort);
      this.running++; item.resolve();
    }
  }
}

if (typeof module !== 'undefined') module.exports = { PreparationQueue, InspectionSlots };
