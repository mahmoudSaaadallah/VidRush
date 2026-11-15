'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PreparationQueue, InspectionSlots } = require('../extension/preparation.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('background queue coalesces traffic, prioritizes the active tab and limits parallel jobs', async () => {
  const started = [], releases = [];
  const queue = new PreparationQueue(id => new Promise(resolve => { started.push(id); releases.push(resolve); }), { limit: 1 });
  queue.schedule(1, { immediate: true }); await tick();
  for (let i = 0; i < 20; i++) queue.schedule(2, { immediate: true });
  queue.schedule(3, { immediate: true, priority: 2 });
  assert.deepEqual(started, [1]);
  releases.shift()(); await tick(); assert.deepEqual(started, [1, 3]);
  releases.shift()(); await tick(); assert.deepEqual(started, [1, 3, 2]);
  releases.shift()(); await tick(); assert.equal(queue.jobs.size, 0);
});

test('cancelled queued inspections never launch and running work observes cancellation', async () => {
  const slots = new InspectionSlots(1), controller = new AbortController();
  let release, launched = false;
  const first = slots.use(() => new Promise(resolve => { release = resolve; })); await tick();
  const second = slots.use(() => { launched = true; }, controller.signal);
  const rejected = assert.rejects(second, /abort/i);
  controller.abort(); await rejected; release(); await first;
  assert.equal(launched, false); assert.equal(slots.running, 0);
  const queue = new PreparationQueue((id, signal) => new Promise(resolve => signal.addEventListener('abort', resolve)));
  const operation = queue.schedule(1, { immediate: true }); await tick();
  queue.cancel(1); await operation; await tick(); assert.equal(queue.running, 0);
});
