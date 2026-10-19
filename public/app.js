(() => {
  'use strict';
  // Speech offsets use the untouched question string's UTF-16 indices. The
  // document receives only the revealed prefix, including for accessibility.
  function createQuestionReveal({ render, activity = () => {}, makeId, setTimer = setTimeout, clearTimer = clearTimeout, wordsPerMinute = 220 }) {
    let original = '', ranges = [], paced = [], end = 0, activeId = null, mode = null, timer = null, serial = 0;
    const delay = 60000 / wordsPerMinute;
    function publish() { render(original.slice(0, end)); }
    function pause() {
      const wasActive = activeId !== null;
      activeId = null; mode = null;
      if (timer !== null) { clearTimer(timer); timer = null; }
      activity(false);
      return wasActive;
    }
    function showThrough(position) { if (position > end) { end = position; publish(); } }
    function punctuationEnd(position) {
      const suffix = original.slice(position).match(/^[^\s\p{L}\p{N}\p{M}]+/u)?.[0] || '';
      return position + suffix.length;
    }
    function load(text) {
      pause(); original = typeof text === 'string' ? text : ''; end = 0;
      // Word segmentation keeps em dashes, slashes, and hyphens from revealing
      // an adjacent, not-yet-spoken word. Segment offsets remain UTF-16.
      const segments = typeof Intl.Segmenter === 'function'
        ? [...new Intl.Segmenter('en', { granularity: 'word' }).segment(original)].map(part => ({ text: part.segment, start: part.index, word: part.isWordLike }))
        : [...original.matchAll(/[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|[^\s\p{L}\p{N}\p{M}]+/gu)].map(part => ({ text: part[0], start: part.index, word: /[\p{L}\p{N}]/u.test(part[0]) }));
      ranges = segments.filter(part => /\S/u.test(part.text)).map(part => ({ ...part, end: part.start + part.text.length }));
      paced = ranges.filter(range => range.word);
      if (!paced.length) paced = ranges;
      publish();
    }
    function finish(requestId) {
      if (requestId !== activeId || activeId === null) return false;
      // A natural speech end may supply trailing punctuation even when a voice
      // omits word events. A cancelled or superseded run can never get here.
      pause(); showThrough(original.length); return true;
    }
    function schedule(requestId) {
      timer = setTimer(() => {
        timer = null;
        if (requestId !== activeId || mode !== 'silent') return;
        const next = paced.find(range => range.end > end);
        if (!next) { finish(requestId); return; }
        showThrough(punctuationEnd(next.end));
        if (next === paced[paced.length - 1]) finish(requestId);
        else schedule(requestId);
      }, delay);
    }
    function start(nextMode, { reset = true } = {}) {
      pause();
      if (reset) { end = 0; publish(); }
      if (!original) return null;
      activeId = makeId ? makeId() : `reveal-${++serial}`; mode = nextMode; activity(true);
      const requestId = activeId;
      if (mode === 'silent') schedule(requestId);
      return requestId;
    }
    function word(requestId, position, count = 0) {
      if (requestId !== activeId || activeId === null || mode !== 'speech' || !Number.isInteger(position) || position < 0 || !Number.isInteger(count) || count < 0 || position + count > original.length) return false;
      // charLength is often zero in browser voices. Resolve that case by the
      // containing word; positive native lengths may span a compound word.
      const boundaryEnd = count ? position + count : position + 1;
      const range = ranges.findLast(value => value.end > position && value.start < boundaryEnd);
      if (!range) return false;
      showThrough(punctuationEnd(range.end)); return true;
    }
    return {
      load, start, word, finish, pause,
      fail(requestId) { if (requestId !== activeId || activeId === null) return false; pause(); return true; },
      revealAll() { pause(); showThrough(original.length); },
      snapshot: () => ({ text: original.slice(0, end), requestId: activeId, mode, active: activeId !== null }),
    };
  }
  // The same controller is exercised without a browser by the focused tests.
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { createQuestionReveal };
    return;
  }
  const TOPICS = ['Science', 'History', 'Literature', 'Fine Arts', 'Geography', 'Religion', 'Mythology', 'Philosophy', 'Social Science', 'Other'];
  const LEVELS = [['middle', 'Middle school'], ['high', 'High school'], ['college', 'College'], ['open', 'Open']];
  const $ = id => document.getElementById(id);
  let csrfToken = '', preferences = { topics: [...TOPICS], levels: LEVELS.map(([id]) => id), readAloud: true };
  let question = null, graded = false, answerPending = false, questionPending = false, questionSequence = 0, questionController = null;
  let preferenceQueue = Promise.resolve(), browserSpeechArmed = false, speaking = false, frozenByAnswer = false;
  let preparationQuestion = null, preparationWarm = false;
  let playbackSequence = 0, playbackReport = null;
  const nativeSpeech = () => typeof window.chrome?.webview?.postMessage === 'function';
  const reveal = createQuestionReveal({ render: text => { $('question').textContent = text; }, activity: active => { speaking = active; speechButtons(); }, makeId: requestId });

  function notify(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
  async function api(url, { body, signal } = {}) {
    const options = { signal, cache: 'no-store', headers: {} };
    if (body !== undefined) { options.method = 'POST'; options.headers['content-type'] = 'application/json'; options.headers['x-practice-token'] = csrfToken; options.body = JSON.stringify(body); }
    const response = await fetch(url, options);
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || value.message || 'This action could not finish. Please try again.');
    return value;
  }
  function makeOptions(container, values, selected, prefix) {
    container.replaceChildren();
    for (const [value, label] of values) {
      const wrapper = document.createElement('label'); wrapper.className = 'check-option';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = value; input.name = prefix; input.checked = selected.includes(value);
      const text = document.createElement('span'); text.textContent = label;
      wrapper.append(input, text); container.append(wrapper);
    }
  }
  function selected(name) { return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value); }
  function savePreferences() {
    const snapshot = { topics: [...preferences.topics], levels: [...preferences.levels], readAloud: preferences.readAloud };
    preferenceQueue = preferenceQueue.catch(() => {}).then(() => api('/api/preferences', { body: snapshot })).catch(error => notify(error.message));
  }
  function renderStats(stats = {}) {
    const answered = Math.max(0, Number(stats.answered) || 0), correct = Math.max(0, Number(stats.correct) || 0);
    $('stat-score').textContent = `${correct} / ${answered}`;
    $('stat-accuracy').textContent = `${answered ? Math.round(correct / answered * 100) : 0}%`;
    $('stat-incorrect').textContent = String(Math.max(0, Number(stats.incorrect) || answered - correct));
    $('stat-streak').textContent = String(Math.max(0, Number(stats.streak) || 0));
    $('stat-best').textContent = String(Math.max(0, Number(stats.bestStreak) || 0));
  }
  function speechButtons() {
    $('read-question').disabled = !question || questionPending || answerPending;
    $('read-question').textContent = !preferences.readAloud || browserSpeechArmed || nativeSpeech() ? 'Replay' : 'Play';
    $('stop-reading').hidden = !speaking;
  }
  function reportPlayback(active) {
    if (!question?.id || (playbackReport?.id === question.id && playbackReport.active === active)) return;
    const report = { id: question.id, active, sequence: ++playbackSequence };
    playbackReport = report;
    // Requests can arrive out of order while a question is skipped or replayed.
    // The server accepts only the current question and its newest sequence.
    void api('/api/playback', { body: report }).catch(() => {
      if (playbackReport === report) playbackReport = null;
    });
  }
  function stopReading({ idle = true } = {}) {
    // Invalidate first: cancellation can emit a synchronous or delayed end.
    reveal.pause();
    if (idle) reportPlayback(false);
    if (nativeSpeech()) { try { window.chrome.webview.postMessage({ action: 'stop' }); } catch {} }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    $('keyboard-hint').textContent = graded ? 'Enter for the next question' : 'Enter to answer';
  }
  function prepareNext({ warmSpeech = false } = {}) {
    if (!question || questionPending || !preferences.topics.length || !preferences.levels.length) return;
    const id = question.id, warm = warmSpeech && preferences.readAloud;
    if (preparationQuestion === id && (!warm || preparationWarm)) return;
    preparationQuestion = id; if (warm) preparationWarm = true;
    // Reserve without revealing the next question or marking it seen. The
    // backend keeps the current voice ahead of this background work.
    void api('/api/prepare-next', { body: { topics: [...preferences.topics], levels: [...preferences.levels], warmSpeech: warm } }).catch(() => {
      if (question?.id === id) { preparationQuestion = null; preparationWarm = false; }
    });
  }
  function freezeForAnswer() { frozenByAnswer = true; stopReading(); prepareNext({ warmSpeech: true }); }
  function readQuestion({ userGesture = false, reset = true } = {}) {
    if (!question?.text || questionPending || answerPending) return;
    if (userGesture) browserSpeechArmed = true;
    // Replay cancels the old voice locally but keeps its foreground priority.
    stopReading({ idle: false });
    frozenByAnswer = false;
    if (!preferences.readAloud) { reportPlayback(false); reveal.start('silent', { reset }); return; }
    if (nativeSpeech()) {
      const id = reveal.start('speech', { reset });
      reportPlayback(true);
      $('keyboard-hint').textContent = 'Preparing voice…';
      try { window.chrome.webview.postMessage({ action: 'speak', text: question.text, requestId: id }); return; }
      catch { reveal.fail(id); }
    }
    if (!('speechSynthesis' in window)) { reportPlayback(false); notify('Voice is unavailable. Reading without audio.'); reveal.start('silent', { reset }); return; }
    if (!browserSpeechArmed) { reportPlayback(false); notify('Press Play to start the question.'); speechButtons(); return; }
    const id = reveal.start('speech', { reset });
    reportPlayback(true);
    const utterance = new SpeechSynthesisUtterance(question.text); utterance.lang = 'en-US'; utterance.rate = 1;
    utterance.onboundary = event => { if (!event.name || event.name === 'word') reveal.word(id, event.charIndex, Number.isInteger(event.charLength) ? event.charLength : 0); };
    utterance.onend = () => { if (reveal.finish(id)) { reportPlayback(false); prepareNext({ warmSpeech: true }); } };
    utterance.onerror = () => { if (reveal.fail(id)) { reportPlayback(false); notify('The voice stopped. Press Replay to try again.'); } };
    try { window.speechSynthesis.speak(utterance); }
    catch { if (reveal.fail(id)) { reportPlayback(false); notify('The voice could not start. Turn off Read aloud to read without audio.'); } }
  }
  function clearFeedback() { $('feedback').hidden = true; $('feedback').className = 'feedback'; $('verdict').textContent = ''; $('correct-answer').textContent = ''; }
  function sourceText(source) {
    if (typeof source === 'string') return source;
    if (!source || typeof source !== 'object') return '';
    return [source.provider, source.setName || source.citation || source.full || source.name || source.title, source.year, source.packetNumber ? `Packet ${source.packetNumber}` : source.packet, source.questionNumber ? `Question ${source.questionNumber}` : ''].filter(Boolean).join(' · ');
  }
  function readyForm() {
    $('answer').disabled = !question || questionPending;
    $('answer').readOnly = graded || answerPending;
    $('submit-answer').disabled = !question || questionPending || answerPending;
    $('skip-question').disabled = questionPending || answerPending || !preferences.topics.length || !preferences.levels.length;
    $('skip-question').textContent = question ? 'Skip' : 'Try again';
    $('submit-answer').textContent = answerPending ? 'Checking…' : graded ? 'Next' : 'Submit';
    $('keyboard-hint').textContent = graded ? 'Enter for the next question' : 'Enter to answer';
    speechButtons();
  }
  async function nextQuestion() {
    const sequence = ++questionSequence;
    const savedPreferences = preferenceQueue, controller = new AbortController();
    questionController?.abort(); questionController = controller;
    stopReading(); reveal.load(''); question = null; graded = false; frozenByAnswer = false; questionPending = true; clearFeedback(); notify();
    preparationQuestion = null; preparationWarm = false;
    $('answer').value = ''; $('question-meta').textContent = ''; $('source').textContent = '';
    $('question').textContent = 'Loading question…'; readyForm();
    if (!preferences.topics.length || !preferences.levels.length) {
      questionPending = false; $('question').textContent = 'Choose at least one topic and level above.'; readyForm(); return;
    }
    try {
      // A delayed older preference write must not cancel this question's
      // background queue after its voice has already begun.
      await savedPreferences;
      if (sequence !== questionSequence) return;
      const query = new URLSearchParams({ topics: preferences.topics.join(','), levels: preferences.levels.join(',') });
      const result = await api(`/api/question?${query}`, { signal: controller.signal });
      if (sequence !== questionSequence) return;
      if (!result.question || result.empty) { $('question').textContent = result.message || 'No questions match these filters.'; return; }
      question = result.question;
      reveal.load(question.text);
      $('question-meta').textContent = [question.topic, LEVELS.find(([id]) => id === question.level)?.[1] || question.level].filter(Boolean).join(' · ');
      $('source').textContent = sourceText(question.source);
    } catch (error) {
      if (sequence !== questionSequence || error.name === 'AbortError') return;
      $('question').textContent = 'The question could not load.'; notify(error.message);
    } finally {
      if (sequence === questionSequence) {
        questionPending = false; readyForm();
        if (question) { $('answer').focus(); readQuestion(); prepareNext({ warmSpeech: preferences.readAloud }); }
      }
    }
  }
  function requestId() { return window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  async function submitAnswer() {
    if (graded) { await nextQuestion(); return; }
    if (!question || answerPending || questionPending) return;
    const attempt = $('answer').value.trim(); if (!attempt) { $('answer').focus(); return; }
    freezeForAnswer(); notify(); answerPending = true; readyForm();
    const submittedId = question.id, submittedSequence = questionSequence;
    try {
      const result = await api('/api/answer', { body: { id: submittedId, attempt, requestId: requestId() } });
      if (result.stats) renderStats(result.stats);
      if (question?.id !== submittedId || questionSequence !== submittedSequence) return;
      if (!['correct', 'incorrect', 'prompt'].includes(result.verdict)) throw new Error('The answer could not be checked. Please try again.');
      $('feedback').hidden = false; $('feedback').className = `feedback ${result.verdict}`;
      if (result.verdict === 'prompt') {
        $('verdict').textContent = 'Be more specific'; $('correct-answer').textContent = ''; graded = false;
      } else {
        graded = true; reveal.revealAll(); $('verdict').textContent = result.verdict === 'correct' ? 'Correct' : 'Incorrect';
        $('correct-answer').textContent = typeof result.answer === 'string' ? result.answer : String(result.answer?.text || result.answer?.canonical || '');
      }
    } catch (error) { notify(error.message); }
    finally { answerPending = false; readyForm(); if (question?.id === submittedId && questionSequence === submittedSequence) { $('answer').focus(); if (!graded) $('answer').setSelectionRange($('answer').value.length, $('answer').value.length); } }
  }
  $('answer-form').addEventListener('submit', event => { event.preventDefault(); void submitAnswer(); });
  $('answer').addEventListener('beforeinput', freezeForAnswer);
  $('answer').addEventListener('compositionstart', freezeForAnswer);
  $('answer').addEventListener('input', freezeForAnswer);
  $('answer').addEventListener('keydown', event => {
    if (!graded && !answerPending && ((!event.ctrlKey && !event.altKey && !event.metaKey && event.key?.length === 1) || event.key === 'Backspace' || event.key === 'Delete')) freezeForAnswer();
  });
  $('skip-question').addEventListener('click', () => void nextQuestion());
  $('read-question').addEventListener('click', () => { notify(); readQuestion({ userGesture: true }); });
  $('stop-reading').addEventListener('click', stopReading);
  $('read-aloud').addEventListener('change', () => {
    const readAloud = preferences.readAloud = $('read-aloud').checked;
    preparationWarm = false; savePreferences(); stopReading();
    if (question && !graded && !frozenByAnswer) readQuestion({ userGesture: true, reset: preferences.readAloud });
    else speechButtons();
    // Turning voices off cancels the backend's warm queue. Re-arm it only
    // after the matching preference is saved, including while an answer is frozen.
    void preferenceQueue.then(() => { if (preferences.readAloud === readAloud) prepareNext({ warmSpeech: readAloud }); });
  });
  for (const id of ['topics', 'levels']) $(id).addEventListener('change', () => { preferences.topics = selected('topic'); preferences.levels = selected('level'); savePreferences(); void nextQuestion(); });
  document.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && graded && !answerPending && !questionPending && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); void nextQuestion(); } });
  window.addEventListener('beforeunload', stopReading);
  if (nativeSpeech()) window.chrome.webview.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'speech-word' && reveal.word(message.requestId, message.position, message.count)) $('keyboard-hint').textContent = 'Enter to answer';
    if (message?.type === 'speech-ended' && reveal.finish(message.requestId)) { reportPlayback(false); prepareNext({ warmSpeech: true }); }
    if (message?.type === 'speech-error' && reveal.fail(message.requestId)) { reportPlayback(false); notify('The voice stopped. Press Replay, or turn off Read aloud to read without audio.'); }
  });
  async function start() {
    try {
      const state = await api('/api/state'); csrfToken = state.csrfToken;
      if (state.preferences) preferences = { topics: Array.isArray(state.preferences.topics) ? state.preferences.topics.filter(x => TOPICS.includes(x)) : [...TOPICS], levels: Array.isArray(state.preferences.levels) ? state.preferences.levels.filter(x => LEVELS.some(([id]) => id === x)) : LEVELS.map(([id]) => id), readAloud: state.preferences.readAloud !== false };
      makeOptions($('topics'), TOPICS.map(topic => [topic, topic]), preferences.topics, 'topic');
      makeOptions($('levels'), LEVELS, preferences.levels, 'level');
      $('read-aloud').checked = preferences.readAloud; renderStats(state.stats); await nextQuestion();
    } catch (error) { $('question').textContent = 'Quiz Practice could not load.'; notify(error.message); }
  }
  void start();
})();
