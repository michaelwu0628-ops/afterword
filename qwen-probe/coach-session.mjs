const PART2_TRANSITIONS = {
  preparing: { start_answer: 'answering' },
  answering: { finish_answer: 'followup' },
  followup: { finish_followups: 'ready_for_review' },
};

function requireText(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new TypeError(`${name} must be a nonempty string of at most ${maximum} characters`);
  }
}

function requireAudioInput(input) {
  if (!input || input.role !== 'user') throw new TypeError('Only user audio can be registered');
  requireText(input.itemId, 'itemId', 256);
  requireText(input.audioRef, 'audioRef', 1024);
  if (input.assistance !== undefined && input.assistance !== 'none' && input.assistance !== 'prompted') {
    throw new TypeError('assistance must be none or prompted');
  }
}

export function createCoachSession({ id, mode = 'material', stopCapture = () => {}, stopPlayback = () => {} }) {
  requireText(id, 'id', 256);
  if (mode !== 'material' && mode !== 'part2') throw new TypeError('mode must be material or part2');
  if (typeof stopCapture !== 'function' || typeof stopPlayback !== 'function') throw new TypeError('Stop hooks must be functions');

  let phase = mode === 'part2' ? 'preparing' : 'chat';
  const turns = [];
  const byItemId = new Map();
  const acceptsAudio = () => phase !== 'ended' && phase !== 'preparing';
  const snapshot = () => structuredClone({ id, mode, phase, turns });

  function registerUserAudio(input) {
    if (!acceptsAudio()) return false;
    requireAudioInput(input);
    if (byItemId.has(input.itemId)) return false;
    const turn = {
      itemId: input.itemId,
      audioRef: input.audioRef,
      assistance: input.assistance ?? 'none',
      phase,
      transcriptionStatus: 'pending',
      text: null,
      rawTranscript: null,
      revisions: [],
      revision: 0,
    };
    turns.push(turn);
    byItemId.set(turn.itemId, turn);
    return true;
  }

  function completeUserTranscript(itemId, text) {
    const turn = byItemId.get(itemId);
    if (!turn || turn.transcriptionStatus !== 'pending') return false;
    requireText(text, 'text', 6000);
    turn.text = text;
    turn.rawTranscript = text;
    turn.transcriptionStatus = 'complete';
    return true;
  }

  return {
    snapshot,
    requestReview(consent) {
      if (consent !== true || (phase !== 'chat' && phase !== 'ready_for_review')) return false;
      phase = 'review';
      return true;
    },
    advancePart2(action) {
      if (mode !== 'part2') return false;
      const nextPhase = Object.hasOwn(PART2_TRANSITIONS, phase) && Object.hasOwn(PART2_TRANSITIONS[phase], action)
        ? PART2_TRANSITIONS[phase][action] : undefined;
      if (!nextPhase) return false;
      phase = nextPhase;
      return true;
    },
    resumeChat() {
      if (phase !== 'review') return false;
      phase = 'chat';
      return true;
    },
    registerUserAudio,
    completeUserTranscript,
    addUserTurn(input) {
      if (!acceptsAudio()) return false;
      requireText(input?.text, 'text', 6000);
      if (!registerUserAudio(input)) return false;
      return completeUserTranscript(input.itemId, input.text);
    },
    correctTurn(itemId, text) {
      const turn = byItemId.get(itemId);
      if (!turn || turn.transcriptionStatus !== 'complete') return false;
      requireText(text, 'text', 6000);
      turn.revisions.push(turn.text);
      turn.text = text;
      turn.revision += 1;
      return turn.revision;
    },
    end() {
      if (phase === 'ended') return snapshot();
      phase = 'ended';
      try {
        stopCapture();
      } finally {
        stopPlayback();
      }
      return snapshot();
    },
  };
}

export function selectPracticeItems(items, { deletedIds = [], suppressedKeys = [], deletedSourceIds = [] } = {}) {
  const removedIds = new Set(deletedIds);
  const removedSources = new Set(deletedSourceIds);
  const suppressedExpressions = new Set(suppressedKeys);
  for (const item of items) {
    if (item.state === 'suppressed' && item.expressionKey !== undefined) suppressedExpressions.add(item.expressionKey);
  }
  return structuredClone(items.filter(item => item.state === 'active'
    && !removedIds.has(item.id)
    && !removedSources.has(item.sourceSessionId)
    && !suppressedExpressions.has(item.expressionKey)));
}
