import test from 'node:test';
import assert from 'node:assert/strict';
let api = {};
try { api = await import('../public/mvp-part2.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const clock = now => { assert.equal(typeof api.createPart2Clock, 'function'); return api.createPart2Clock({ now }); };
test('twelve original topic cards have unique identities and complete prompts', () => {
  assert.ok(Array.isArray(api.TOPICS)); assert.equal(api.TOPICS.length, 12);
  assert.equal(new Set(api.TOPICS.map(t => t.id)).size, 12);
  assert.ok(api.TOPICS.every(t => t.category && t.title && t.prompt.startsWith('Describe') && t.bullets.length >= 3 && t.bullets.every(Boolean)));
});
test('preparation and independent answer have separate 60 and 120 second deadlines', () => {
  let time = 100; const c = clock(() => time);
  assert.deepEqual(c.tick(), { phase: 'idle', remainingMs: 0 });
  assert.deepEqual(c.prepare(), { phase: 'preparing', remainingMs: 60_000 });
  time += 23_000; assert.deepEqual(c.tick(), { phase: 'preparing', remainingMs: 37_000 });
  assert.deepEqual(c.answer(), { phase: 'answering', remainingMs: 120_000 });
  time += 91_000; assert.deepEqual(c.tick(), { phase: 'answering', remainingMs: 29_000 });
  assert.deepEqual(c.finish(), { phase: 'finished', remainingMs: 0 });
});
test('timer expiry never submits or changes an independent answer phase', () => {
  let time = 0; const c = clock(() => time); c.prepare(); time = 90_000;
  assert.deepEqual(c.tick(), { phase: 'preparing', remainingMs: 0 });
  c.answer(); time += 125_000;
  assert.deepEqual(c.tick(), { phase: 'answering', remainingMs: 0 });
  assert.deepEqual(c.tick(), { phase: 'answering', remainingMs: 0 });
});
test('repeated phase calls do not reset a running deadline and a fresh prepare starts a new attempt', () => {
  let time = 0; const c = clock(() => time); c.answer(); time = 50_000;
  assert.equal(c.answer().remainingMs, 70_000); c.finish();
  assert.equal(c.prepare().remainingMs, 60_000);
});
