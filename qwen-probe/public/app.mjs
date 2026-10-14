import { createConnection, createDraft } from './connection.mjs';
import { createCapture, createPlayback, pcmToBase64 } from './audio.mjs';

export function deriveControls(s) {
  const ready = s.state === 'ready';
  const stopped = s.draftState === 'stopped' && s.draftLength >= 1600;
  const busy = s.recording || s.submitting || s.awaitingResponse || s.responseActive;
  return {
    connect: s.state === 'disconnected', disconnect: s.state !== 'disconnected',
    record: ready && s.mode === 'manual' && !busy, stop: !!s.recording && s.mode === 'manual',
    replay: stopped && !s.recording && !s.submitting, download: stopped && !s.recording && !s.submitting,
    discard: !!s.draftLength && !s.recording && !s.submitting,
    send: ready && s.mode === 'manual' && stopped && !busy && !s.submitted,
    startCall: ready && s.mode === 'realtime' && !busy,
    stopCall: s.mode === 'realtime' && !!s.recording, cancel: ready && !!(s.responseActive || s.playbackPending),
    feedback: ready && !!s.itemId && !s.feedbackPending && !!s.feedbackText?.trim(),
  };
}

// Browser dependencies remain injectable for offline lifecycle tests.
export function createApp(document, { window = globalThis.window, connectionFactory = createConnection, captureFactory = createCapture, playbackFactory = createPlayback, objectURL = globalThis.URL, BlobImpl = globalThis.Blob } = {}) {
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries(['workspace', 'api-key', 'connect', 'disconnect', 'mode-fieldset', 'manual-panel', 'realtime-panel', 'record', 'stop', 'replay', 'download', 'discard', 'send', 'start-call', 'stop-call', 'cancel', 'draft-player', 'duration', 'draft-status', 'recording-orbit', 'sent-status', 'status', 'detail', 'status-dot', 'response-status', 'assistant-text', 'user-transcript', 'transcript-status', 'correction-panel', 'feedback-text', 'feedback', 'feedback-status', 'feedback-result', 'voice-usage', 'text-usage'].map(id => [id, $(id)]));
  let capture = null, playback = null, draft = null, draftSamples = null, blobURL = null, captureGeneration = 0, sessionGeneration = 0, disposed = false;
  let textReply = '', transcriptReply = '';
  let lastFailure = null;
  let targetSource = 'transcript';
  const seenInputItems = new Set(), finalizedInputItems = new Set();
  const s = { state: 'disconnected', mode: 'manual', recording: false, submitting: false, submitted: false, responseActive: false, awaitingResponse: false, feedbackPending: false, feedbackText: '', itemId: null, draftState: '', draftLength: 0 };
  const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
  function status(title, detail, error = false) { ui.status.textContent = title; ui.detail.textContent = detail; ui['status-dot'].classList.toggle('error', error); }
  function render() {
    const controls = deriveControls(s);
    for (const [state, id] of Object.entries({ connect: 'connect', disconnect: 'disconnect', record: 'record', stop: 'stop', replay: 'replay', download: 'download', discard: 'discard', send: 'send', startCall: 'start-call', stopCall: 'stop-call', cancel: 'cancel', feedback: 'feedback' })) ui[id].disabled = disposed || !controls[state];
    for (const input of [ui['api-key'], ui.workspace, ...modeInputs]) input.disabled = disposed || s.state !== 'disconnected';
    ui['manual-panel'].hidden = s.mode !== 'manual'; ui['realtime-panel'].hidden = s.mode !== 'realtime';
    ui['recording-orbit'].classList.toggle('active', s.recording); ui['status-dot'].classList.toggle('ready', s.state === 'ready');
  }
  function revokeDraft() {
    ui['draft-player'].pause(); ui['draft-player'].removeAttribute('src'); ui['draft-player'].load(); ui['draft-player'].hidden = true;
    if (blobURL) objectURL.revokeObjectURL(blobURL); blobURL = null;
  }
  function clearDraft() {
    revokeDraft(); draft?.discard(); draft = null; draftSamples = null;
    s.draftLength = 0; s.draftState = ''; s.submitted = false;
    ui.duration.textContent = '0.0 秒 / 30 秒'; ui['draft-status'].textContent = '还没有录音草稿';
  }
  function stopResources() {
    sessionGeneration++; captureGeneration++; const old = capture; capture = null; void old?.dispose().catch(() => {});
    const player = playback; playback = null; void player?.dispose().catch(() => {});
    s.recording = false; s.responseActive = false; s.playbackPending = false; s.awaitingResponse = false; s.submitting = false; s.feedbackPending = false;
    clearDraft(); resetFeedback(); seenInputItems.clear(); finalizedInputItems.clear();
  }
  function resetFeedback() {
    s.itemId = null; s.feedbackText = ''; s.feedbackPending = false; targetSource = 'transcript';
    ui['user-transcript'].textContent = ''; ui['transcript-status'].textContent = '发送录音后，自动显示识别结果。';
    ui['feedback-text'].value = ''; ui['correction-panel'].open = false;
    ui['feedback-result'].replaceChildren(); ui['feedback-status'].textContent = '';
  }
  function waitForRecognition() {
    resetFeedback(); ui['transcript-status'].textContent = '识别中 · 等待本轮最终识别结果。';
  }
  function selectInput(itemId) {
    if (seenInputItems.has(itemId)) return itemId === s.itemId;
    if (seenInputItems.size >= 256) { const oldest = seenInputItems.values().next().value; seenInputItems.delete(oldest); finalizedInputItems.delete(oldest); }
    seenInputItems.add(itemId); waitForRecognition(); s.itemId = itemId; return true;
  }
  function matchesFeedback(event) {
    return event.itemId ? event.itemId === s.itemId && event.source === targetSource : !s.itemId;
  }
  function realUsage(element, usage, prefix = '') { element.textContent = Object.keys(usage || {}).length ? prefix + JSON.stringify(usage, null, 2) : '本次服务未返回可展示用量'; }
  function showFeedback(result) {
    ui['feedback-result'].replaceChildren();
    const summary = document.createElement('p'); summary.textContent = result.summary; ui['feedback-result'].append(summary);
    for (const item of result.suggestions) {
      const row = document.createElement('div'); row.className = 'suggestion';
      for (const [label, value] of [['原文', item.original], ['建议', item.suggestion], ['原因', item.reason]]) {
        const heading = document.createElement('strong'); heading.textContent = label;
        const text = document.createElement('p'); text.textContent = value; row.append(heading, text);
      }
      ui['feedback-result'].append(row);
    }
  }
  function onEvent(event) {
    if (disposed || (s.state === 'disconnected' && event.type !== 'connection_state')) return;
    if (event.type === 'connection_state') {
      s.state = event.state;
      if (s.state === 'disconnected') { stopResources(); if (lastFailure) status('请求未完成', lastFailure, true); else status('尚未连接', '本次连接已结束；不会自动重连。'); }
      if (s.state === 'connecting') status('正在连接', '等待 session.created 和配置确认，尚未就绪。');
    } else if (event.type === 'ready') status('已就绪 · 配置确认', '模型已确认配置。现在可由你开始录音或实时通话。');
    else if (['user.transcription_pending', 'user.transcript', 'user.transcription_failed'].includes(event.type)) {
      if (!selectInput(event.itemId) || finalizedInputItems.has(event.itemId)) return;
      if (event.type === 'user.transcript') {
        finalizedInputItems.add(event.itemId); s.feedbackText = event.text;
        ui['user-transcript'].textContent = event.text; ui['feedback-text'].value = event.text;
        ui['transcript-status'].textContent = '已自动识别 · 如有误，可展开更正原话。';
        ui['feedback-status'].textContent = '等待点评…';
      } else if (event.type === 'user.transcription_failed') {
        finalizedInputItems.add(event.itemId); s.itemId = null;
        ui['transcript-status'].textContent = `识别失败 [${event.code}] · 尚无完整识别结果，请重新录制并发送。`;
        ui['feedback-status'].textContent = '没有可供点评的原话。';
      }
    } else if (event.type === 'error' || event.type === 'feedback.error') {
      const code = event.code || 'REQUEST_FAILED';
      if (event.request === 'feedback' || event.type === 'feedback.error') {
        if (!matchesFeedback(event)) return;
        s.feedbackPending = false;
        ui['feedback-status'].textContent = `点评失败 [${code}${event.httpStatus ? ` / HTTP ${event.httpStatus}` : ''}]，可展开更正入口重新分析。`;
        render(); return;
      }
      if (lastFailure && ['connection_closed', 'connection_error'].includes(event.code)) { render(); return; }
      s.awaitingResponse = false;
      lastFailure = `${event.message || '请检查配置后手动重试。'} [${code}${event.httpStatus ? ` / HTTP ${event.httpStatus}` : ''}]`;
      status('请求未完成', lastFailure, true);
    } else if (event.type === 'response.created') {
      s.responseActive = true; s.awaitingResponse = true; textReply = ''; transcriptReply = '';
      ui['assistant-text'].textContent = ''; ui['response-status'].textContent = '正在接收模型回复…'; playback?.activate(event.responseId);
    } else if (event.type === 'response.audio.delta') {
      try { if (!playback?.enqueue(event.delta, event.responseId)) { connection.send('cancel_response'); playback?.stop(); s.responseActive = false; s.awaitingResponse = false; ui['response-status'].textContent = '播放队列不可用或已满，已停止回复。请手动重试。'; } }
      catch { connection.send('cancel_response'); playback?.stop(); s.responseActive = false; s.awaitingResponse = false; ui['response-status'].textContent = '音频格式不符合预期，已停止回复。'; }
    } else if (['response.audio_transcript.delta', 'response.audio_transcript.done', 'response.text.delta', 'response.text.done'].includes(event.type)) {
      if (event.type === 'response.audio_transcript.delta') transcriptReply += event.delta;
      if (event.type === 'response.audio_transcript.done') transcriptReply = event.transcript;
      if (event.type === 'response.text.delta') textReply += event.delta;
      if (event.type === 'response.text.done') textReply = event.text;
      ui['assistant-text'].textContent = transcriptReply || textReply;
    } else if (event.type === 'response.done') {
      s.responseActive = false; s.awaitingResponse = false; ui['response-status'].textContent = `本轮回复结束，服务状态：${event.status}`; realUsage(ui['voice-usage'], event.usage);
    } else if (event.type === 'response.usage') realUsage(ui['voice-usage'], event.usage, '已取消回复的实际用量\n');
    else if (event.type === 'response.canceled' || event.type === 'input_audio_buffer.speech_started') {
      playback?.stop(); s.responseActive = false; s.awaitingResponse = false;
      ui['response-status'].textContent = event.type === 'response.canceled' ? '本轮回复已取消。' : '检测到说话，已停止当前播放。打断后的上下文一致性仍待验证。';
    } else if (event.type === 'input_audio_buffer.speech_stopped') {
      s.awaitingResponse = true; ui['response-status'].textContent = '服务端已检测本轮说话结束，等待回复。';
    } else if (event.type === 'feedback.pending') {
      if (!matchesFeedback(event)) return;
      s.feedbackPending = true; ui['feedback-status'].textContent = event.queued ? '等待点评 · 前一轮仍在分析…' : '点评中 · 分析你的英文表达…';
    } else if (event.type === 'feedback.result') {
      realUsage(ui['text-usage'], event.usage);
      if (!matchesFeedback(event)) return;
      s.feedbackPending = false;
      const source = event.source === 'correction' ? '更正后的原话' : '自动识别的原话';
      ui['feedback-status'].textContent = event.result.assessment === 'no_clear_issue' ? `无需修改 · 已分析${source}。` : `已点评${source}。`;
      showFeedback(event.result);
    }
    render();
  }
  const connection = connectionFactory({ url: `ws://${window.location.host}/connect`, onEvent });
  function ensurePlayback() { playback ??= playbackFactory({ onStateChange() { s.playbackPending = !!playback?.playing; render(); } }); return playback.unlock(); }
  async function beginCapture(realtime) {
    if (disposed || !deriveControls(s)[realtime ? 'startCall' : 'record']) return;
    clearDraft(); s.recording = true; render();
    const token = ++captureGeneration; let liveChunks = [], liveLength = 0;
    if (!realtime) { draft = createDraft(); s.draftState = 'recording'; }
    function flushLive() {
      if (!liveLength) return true;
      const pcm = new Int16Array(liveLength); let offset = 0; for (const chunk of liveChunks) { pcm.set(chunk, offset); offset += chunk.length; }
      liveChunks = []; liveLength = 0;
      return connection.send('audio', { audio: pcmToBase64(pcm) });
    }
    try {
      const unlocked = await ensurePlayback();
      if (token !== captureGeneration) return;
      if (!unlocked) throw new Error('PLAYBACK');
      if (realtime && !connection.send('start_turn')) throw new Error('NOT_READY');
      if (realtime) waitForRecognition();
      capture = captureFactory({ onPcm(pcm) {
        if (token !== captureGeneration) return;
        s.draftLength += pcm.length; ui.duration.textContent = `${(s.draftLength / 16000).toFixed(1)} 秒 / 30 秒`;
        if (realtime) { liveChunks.push(pcm.slice()); liveLength += pcm.length; if (liveLength >= 1600 && !flushLive()) void capture?.stop('network'); }
        else { draft.push(pcm); ui['draft-status'].textContent = '正在录音 · 仅留在本机'; }
      }, onStop(result) {
        if (token !== captureGeneration) return;
        s.recording = false; capture = null;
        if (realtime) {
          flushLive(); s.draftLength = 0;
          ui['sent-status'].textContent = `${result.reason === 'limit' ? '已达 30 秒并停止收音。' : '已停止收音并释放麦克风。'}音频已发送；${ui['user-transcript'].textContent ? '已完成轮次的识别保留，后续结果仍可能到达。' : '尚无完整识别结果，等待最终识别。'}`;
        } else {
          draft?.stop(); s.draftState = 'stopped'; draftSamples = result.pcm; s.draftLength = result.pcm.length;
          if (result.pcm.length) { blobURL = objectURL.createObjectURL(new BlobImpl([result.wav], { type: 'audio/wav' })); ui['draft-player'].src = blobURL; ui['draft-player'].hidden = false; }
          ui['draft-status'].textContent = result.reason === 'limit' ? '已达 30 秒 · 草稿未发送' : result.reason === 'error' ? '录音未成功，请检查麦克风权限' : '草稿已停止 · 尚未发送';
        }
        render();
      } });
      const result = await capture.start();
      if (!result || token !== captureGeneration) return;
      if (realtime) ui['sent-status'].textContent = '实时收音中，语音正在发送到百炼。说完请等待约 5 秒。';
      render();
    } catch {
      if (token !== captureGeneration) return;
      s.recording = false; const old = capture; capture = null; void old?.dispose().catch(() => {});
      status('录音未开始', '请检查麦克风权限和浏览器音频支持，再由你手动重试。', true); render();
    }
  }
  ui.connect.addEventListener('click', () => {
    if (disposed) return; lastFailure = null;
    const apiKey = ui['api-key'].value; ui['api-key'].value = '';
    s.mode = modeInputs.find(input => input.checked)?.value || 'manual';
    ui['assistant-text'].textContent = ''; resetFeedback(); seenInputItems.clear(); finalizedInputItems.clear();
    ui['voice-usage'].textContent = '尚无服务返回用量'; ui['text-usage'].textContent = '尚无服务返回用量';
    try { connection.connect({ apiKey, workspace: ui.workspace.value, mode: s.mode }); }
    catch (error) { status('尚未连接', error.message, true); }
    render();
  });
  ui.disconnect.addEventListener('click', () => { lastFailure = null; stopResources(); connection.disconnect(); render(); });
  for (const input of modeInputs) input.addEventListener('change', () => { if (s.state === 'disconnected') { s.mode = input.value; render(); } });
  ui.record.addEventListener('click', () => { void beginCapture(false); });
  ui['start-call'].addEventListener('click', () => { void beginCapture(true); });
  function stopCapture() {
    if (capture) { void capture.stop('manual'); return; }
    // A stop during playback-unlock must cancel the subsequent permission request.
    captureGeneration++; s.recording = false; draft?.stop(); s.draftState = draft?.state || '';
    ui['draft-status'].textContent = '已取消录音启动'; render();
  }
  ui.stop.addEventListener('click', stopCapture);
  ui['stop-call'].addEventListener('click', stopCapture);
  ui.discard.addEventListener('click', () => { clearDraft(); render(); });
  ui.replay.addEventListener('click', () => { playback?.stop(); ui['draft-player'].currentTime = 0; void ui['draft-player'].play().catch(() => { status('回放未开始', '请检查浏览器播放权限后再试。', true); }); });
  ui.download.addEventListener('click', () => { if (!blobURL) return; const link = document.createElement('a'); link.href = blobURL; link.download = 'qwen-local-draft.wav'; link.click(); });
  ui.send.addEventListener('click', async () => {
    if (!deriveControls(s).send || !draftSamples) return;
    const generation = sessionGeneration; const samples = draftSamples;
    s.submitting = true; s.submitted = true; s.awaitingResponse = true; waitForRecognition(); render();
    ui['draft-player'].pause(); ui['draft-status'].textContent = '正在发送 · 每份草稿仅发送一次';
    try {
      if (!await ensurePlayback()) throw new Error('PLAYBACK');
      if (generation !== sessionGeneration) return;
      await connection.submitDraft(samples);
      if (generation !== sessionGeneration) return;
      ui['sent-status'].textContent = `已发送 ${(samples.length / 16000).toFixed(1)} 秒音频；等待自动识别、表达建议与模型回复。`; ui['draft-status'].textContent = '这份草稿已发送';
    } catch { if (generation === sessionGeneration) { s.awaitingResponse = false; status('发送未完成', '音频可能只发送了一部分。请手动重连并录制新草稿。', true); } }
    finally { if (generation === sessionGeneration) { s.submitting = false; render(); } }
  });
  ui.cancel.addEventListener('click', () => { playback?.stop(); if (s.responseActive) connection.send('cancel_response'); s.responseActive = false; s.awaitingResponse = false; render(); });
  ui['feedback-text'].addEventListener('input', () => { s.feedbackText = ui['feedback-text'].value; render(); });
  ui.feedback.addEventListener('click', () => {
    if (!deriveControls(s).feedback) return; ui['feedback-result'].replaceChildren(); s.feedbackPending = true; targetSource = 'correction';
    ui['feedback-status'].textContent = '等待点评 · 已提交更正后的原话…';
    if (!connection.feedback(ui['feedback-text'].value, s.itemId)) { s.feedbackPending = false; ui['feedback-status'].textContent = '文字请求未发出，请检查连接。'; }
    render();
  });
  function dispose() { if (disposed) return; disposed = true; stopResources(); s.state = 'disconnected'; ui['api-key'].value = ''; connection.disconnect(); status('连接已停止', '页面已离开。返回此页后请刷新，再由你手动连接。'); render(); }
  window.addEventListener('pagehide', dispose); render();
  return { dispose, get state() { return { ...s }; } };
}
if (typeof document !== 'undefined') createApp(document);
