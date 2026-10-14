import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoachSession, selectPracticeItems } from '../coach-session.mjs';

const audio = (itemId, overrides = {}) => ({ itemId, role: 'user', audioRef: `local:${itemId}`, ...overrides });

test('material review is voluntary and can return to chat', () => {
  const session = createCoachSession({ id: 'material-session' });
  assert.deepEqual(session.snapshot(), { id: 'material-session', mode: 'material', phase: 'chat', turns: [] });
  assert.equal(session.requestReview(false), false);
  assert.equal(session.snapshot().phase, 'chat');
  assert.equal(session.resumeChat(), false);
  assert.equal(session.requestReview(true), true);
  assert.equal(session.snapshot().phase, 'review');
  assert.equal(session.requestReview(true), false);
  assert.equal(session.resumeChat(), true);
  assert.equal(session.snapshot().phase, 'chat');
  for (const id of ['', ' ', 'x'.repeat(257), null]) assert.throws(() => createCoachSession({ id }));
  assert.throws(() => createCoachSession({ id: 'bad-mode', mode: 'unknown' }));
  assert.equal(createCoachSession({ id: 'x'.repeat(256) }).snapshot().id.length, 256);
});

test('Part 2 permits review only after the answer and follow-up questions finish', () => {
  const session = createCoachSession({ id: 'part-2', mode: 'part2' });
  assert.equal(session.snapshot().phase, 'preparing');
  assert.equal(session.requestReview(true), false);
  assert.equal(session.registerUserAudio(audio('too-early')), false);
  assert.equal(session.advancePart2('finish_answer'), false);
  assert.equal(session.advancePart2('start_answer'), true);
  assert.equal(session.snapshot().phase, 'answering');
  assert.equal(session.addUserTurn({ ...audio('answer'), text: 'I visited an old friend.' }), true);
  assert.equal(session.requestReview(true), false);
  assert.equal(session.advancePart2('finish_followups'), false);
  assert.equal(session.advancePart2('finish_answer'), true);
  assert.equal(session.snapshot().phase, 'followup');
  assert.equal(session.addUserTurn({ ...audio('followup'), text: 'We met at university.' }), true);
  assert.equal(session.requestReview(true), false);
  assert.equal(session.advancePart2('finish_followups'), true);
  assert.equal(session.snapshot().phase, 'ready_for_review');
  assert.equal(session.requestReview(false), false);
  assert.equal(session.requestReview(true), true);
  assert.equal(session.advancePart2('start_answer'), false);
  assert.deepEqual(session.snapshot().turns.map(turn => turn.phase), ['answering', 'followup']);
  assert.equal(createCoachSession({ id: 'material' }).advancePart2('start_answer'), false);
});

test('audio registration accepts only user input, is idempotent, and isolates snapshots', () => {
  const session = createCoachSession({ id: 'evidence' });
  for (const role of ['assistant', 'system', '', undefined]) assert.throws(() => session.registerUserAudio(audio('wrong-role', { role })));
  for (const itemId of ['', ' ', 'x'.repeat(257), null]) assert.throws(() => session.registerUserAudio(audio(itemId)));
  for (const audioRef of ['', ' ']) {
    assert.throws(() => session.registerUserAudio(audio('empty-ref', { audioRef })));
    assert.equal(session.snapshot().turns.some(turn => turn.itemId === 'empty-ref'), false);
  }
  assert.throws(() => session.registerUserAudio(audio('long-ref', { audioRef: 'x'.repeat(1025) })));
  assert.throws(() => session.registerUserAudio(audio('bad-ref', { audioRef: {} })));
  assert.throws(() => session.registerUserAudio(audio('bad-help', { assistance: 'generated' })));
  assert.equal(session.registerUserAudio(audio('original')), true);
  assert.equal(session.registerUserAudio(audio('original', { audioRef: 'local:replacement', assistance: 'prompted' })), false);
  let snapshot = session.snapshot();
  assert.equal(snapshot.turns.length, 1);
  assert.deepEqual(snapshot.turns[0], {
    itemId: 'original', audioRef: 'local:original', assistance: 'none', phase: 'chat',
    transcriptionStatus: 'pending', text: null, rawTranscript: null, revisions: [], revision: 0,
  });
  assert.equal(session.completeUserTranscript('unknown', 'A fabricated utterance.'), false);
  for (const text of ['', ' ', 'x'.repeat(6001), null]) assert.throws(() => session.completeUserTranscript('original', text));
  assert.equal(session.completeUserTranscript('original', 'I enjoy long walks.'), true);
  assert.equal(session.completeUserTranscript('original', 'A later duplicate.'), false);
  snapshot.turns[0].audioRef = 'changed';
  snapshot.turns[0].revisions.push('changed');
  snapshot.turns.push({ itemId: 'injected' });
  snapshot = session.snapshot();
  snapshot.turns[0].text = 'changed';
  assert.equal(session.snapshot().turns[0].text, 'I enjoy long walks.');
  assert.equal(session.snapshot().turns[0].rawTranscript, 'I enjoy long walks.');
  assert.equal(session.snapshot().turns[0].transcriptionStatus, 'complete');
  assert.equal(session.snapshot().turns[0].audioRef, 'local:original');
  assert.deepEqual(session.snapshot().turns[0].revisions, []);
  assert.equal(session.snapshot().turns.length, 1);
});

test('corrections preserve raw transcripts while a short practice attempt keeps its own evidence', () => {
  const session = createCoachSession({ id: 'correction' });
  assert.equal(session.addUserTurn({ ...audio('original'), text: 'I very like podcasts.' }), true);
  assert.equal(session.correctTurn('missing', 'I really like podcasts.'), false);
  assert.equal(session.registerUserAudio(audio('pending')), true);
  assert.equal(session.correctTurn('pending', 'I really like podcasts.'), false);
  for (const text of ['', ' ', 'x'.repeat(6001)]) assert.throws(() => session.correctTurn('original', text));
  assert.equal(session.correctTurn('original', 'I really like podcasts.'), 1);
  assert.equal(session.correctTurn('original', 'I really enjoy podcasts.'), 2);
  assert.equal(session.requestReview(true), true);
  assert.equal(session.addUserTurn({ ...audio('short-practice', { audioRef: 'local:short-practice-audio', assistance: 'prompted' }), text: 'I really enjoy podcasts.' }), true);
  assert.equal(session.resumeChat(), true);
  const [original, pending, practice] = session.snapshot().turns;
  assert.equal(original.rawTranscript, 'I very like podcasts.');
  assert.equal(original.text, 'I really enjoy podcasts.');
  assert.deepEqual(original.revisions, ['I very like podcasts.', 'I really like podcasts.']);
  assert.equal(original.revision, 2);
  assert.equal(original.phase, 'chat');
  assert.equal(original.audioRef, 'local:original');
  assert.equal(original.assistance, 'none');
  assert.equal(pending.transcriptionStatus, 'pending');
  assert.equal(practice.phase, 'review');
  assert.equal(practice.audioRef, 'local:short-practice-audio');
  assert.equal(practice.assistance, 'prompted');
  assert.equal(practice.rawTranscript, 'I really enjoy podcasts.');
  const copy = session.snapshot();
  copy.turns[0].revisions[0] = 'overwritten';
  assert.equal(session.snapshot().turns[0].revisions[0], 'I very like podcasts.');
  assert.throws(() => session.addUserTurn({ ...audio('invalid-new-turn'), text: '' }));
  assert.equal(session.snapshot().turns.some(turn => turn.itemId === 'invalid-new-turn'), false);
});

test('ending releases hooks once, retains evidence, allows pending ASR, and prevents restart', () => {
  const calls = [];
  let session;
  session = createCoachSession({ id: 'hangup', stopCapture: () => calls.push(['capture', session.snapshot().phase]), stopPlayback: () => calls.push(['playback', session.snapshot().phase]) });
  assert.equal(session.addUserTurn({ ...audio('complete'), text: 'I enjoy podcasts.' }), true);
  assert.equal(session.registerUserAudio(audio('pending')), true);
  const ended = session.end();
  assert.deepEqual(calls, [['capture', 'ended'], ['playback', 'ended']]);
  assert.equal(ended.phase, 'ended');
  assert.equal(ended.turns.length, 2);
  ended.turns[0].text = 'mutated return';
  ended.turns[0].revisions.push('mutated return');
  ended.turns.push({ itemId: 'injected' });
  assert.equal(session.snapshot().turns[0].text, 'I enjoy podcasts.');
  assert.deepEqual(session.snapshot().turns[0].revisions, []);
  assert.equal(session.snapshot().phase, 'ended');
  assert.equal(session.snapshot().turns.length, 2);
  assert.equal(session.registerUserAudio(audio('after-end')), false);
  assert.equal(session.addUserTurn({ ...audio('after-end'), text: 'A new utterance.' }), false);
  assert.equal(session.completeUserTranscript('unknown', 'An unregistered utterance.'), false);
  assert.equal(session.completeUserTranscript('pending', 'A delayed user transcript.'), true);
  assert.equal(session.completeUserTranscript('pending', 'A duplicate.'), false);
  assert.equal(session.snapshot().turns[1].phase, 'chat');
  assert.equal(session.snapshot().turns[1].rawTranscript, 'A delayed user transcript.');
  assert.equal(session.requestReview(true), false);
  assert.equal(session.resumeChat(), false);
  assert.equal(session.advancePart2('start_answer'), false);
  const repeatedEnd = session.end();
  assert.equal(repeatedEnd.phase, 'ended');
  assert.equal(repeatedEnd.turns.length, 2);
  repeatedEnd.turns[1].rawTranscript = 'mutated repeated return';
  assert.equal(session.snapshot().turns[1].rawTranscript, 'A delayed user transcript.');
  assert.equal(calls.length, 2);
  assert.equal(session.snapshot().phase, 'ended');
});

test('playback is stopped even when stopping capture throws', () => {
  const calls = [];
  const failure = new Error('capture stop failed');
  const session = createCoachSession({ id: 'hook-error', stopCapture: () => { calls.push('capture'); throw failure; }, stopPlayback: () => calls.push('playback') });
  session.registerUserAudio(audio('kept'));
  assert.throws(() => session.end(), error => error === failure);
  assert.deepEqual(calls, ['capture', 'playback']);
  assert.equal(session.snapshot().phase, 'ended');
  assert.equal(session.snapshot().turns[0].itemId, 'kept');
  assert.doesNotThrow(() => session.end());
  assert.deepEqual(calls, ['capture', 'playback']);
});

test('practice candidates respect deletions, suppressed expressions, and deleted source records', () => {
  const items = [
    { id: 'keep', state: 'active', sourceSessionId: 'source-live', expressionKey: 'keep-key', evidence: { labels: ['original'] } },
    { id: 'deleted', state: 'active', sourceSessionId: 'source-live', expressionKey: 'deleted-key' },
    { id: 'lost-source', state: 'active', sourceSessionId: 'source-deleted', expressionKey: 'source-key' },
    { id: 'suppressed-option', state: 'active', expressionKey: 'option-key' },
    { id: 'retired', state: 'suppressed', expressionKey: 'retired-key' },
    { id: 'recreated', state: 'active', expressionKey: 'retired-key' },
    { id: 'inactive', state: 'deleted', expressionKey: 'inactive-key' },
  ];
  const selected = selectPracticeItems(items, { deletedIds: ['deleted'], suppressedKeys: ['option-key'], deletedSourceIds: ['source-deleted'] });
  assert.deepEqual(selected.map(item => item.id), ['keep']);
  selected[0].evidence.labels.push('mutated');
  assert.deepEqual(items[0].evidence.labels, ['original']);
  assert.deepEqual(selectPracticeItems(items).map(item => item.id), ['keep', 'deleted', 'lost-source', 'suppressed-option']);
  assert.deepEqual(selectPracticeItems([]), []);
});
