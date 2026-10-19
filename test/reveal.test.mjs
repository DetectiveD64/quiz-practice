import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const controllerModule = { exports: {} };
vm.runInNewContext(source, { module: controllerModule, setTimeout, clearTimeout });
const { createQuestionReveal } = controllerModule.exports;

function clock() {
  let serial = 0;
  const waiting = new Map(), history = new Map();
  return {
    setTimer(fn, ms) { const id = ++serial; waiting.set(id, { fn, ms }); history.set(id, fn); return id; },
    clearTimer(id) { waiting.delete(id); },
    next() { const [id, item] = waiting.entries().next().value || []; if (!item) return false; waiting.delete(id); item.fn(); return true; },
    late(id) { history.get(id)?.(); },
    get lastId() { return serial; },
    get size() { return waiting.size; },
    get delay() { return waiting.values().next().value?.ms; },
  };
}
function controller(text) {
  const time = clock(), rendered = [], active = [];
  const reveal = createQuestionReveal({ render: value => rendered.push(value), activity: value => active.push(value), ...time });
  reveal.load(text);
  return { reveal, time, rendered, active, visible: () => rendered.at(-1) };
}

test('a question begins blank and speech boundaries append complete words and punctuation', () => {
  const { reveal, visible } = controller('“Hello,” she said.');
  const id = reveal.start('speech');
  assert.equal(visible(), '');
  reveal.word(id, 1, 5); assert.equal(visible(), '“Hello,”');
  reveal.word(id, 9, 3); assert.equal(visible(), '“Hello,” she');
  reveal.word(id, 0, 1); assert.equal(visible(), '“Hello,” she');
  reveal.word(id, 13, 4); assert.equal(visible(), '“Hello,” she said.');
});

test('UTF-16 positions preserve emoji, accents, nonbreaking spaces, and hyphenated words', () => {
  const text = '🧪 sodium-chloride — café!\u00a0Next.';
  const { reveal, visible } = controller(text);
  const id = reveal.start('speech');
  reveal.word(id, text.indexOf('sodium'), 6);
  assert.equal(visible(), '🧪 sodium-');
  reveal.word(id, text.indexOf('chloride'), 8);
  assert.equal(visible(), '🧪 sodium-chloride');
  reveal.word(id, text.indexOf('café'), 0);
  assert.equal(visible(), '🧪 sodium-chloride — café!');
  assert.equal(visible().includes('Next'), false);
});

test('native word lengths never expose the next em-dash or slash-separated word', () => {
  const { reveal, visible } = controller('red—blue and/or green.');
  const id = reveal.start('speech');
  reveal.word(id, 0, 3); assert.equal(visible(), 'red—');
  assert.equal(visible().includes('blue'), false);
  reveal.word(id, 4, 4); assert.equal(visible(), 'red—blue');
  reveal.word(id, 9, 3); assert.equal(visible(), 'red—blue and/');
  assert.equal(visible().includes('or'), false);
  reveal.word(id, 13, 0); assert.equal(visible(), 'red—blue and/or');
});

test('zero-length browser word events work, while malformed and whitespace offsets reveal nothing', () => {
  const { reveal, visible } = controller('One two.');
  const id = reveal.start('speech');
  assert.equal(reveal.word(id, -1, 1), false);
  assert.equal(reveal.word(id, 3, 1), false);
  assert.equal(reveal.word(id, 4.5, 1), false);
  assert.equal(reveal.word(id, 99, 1), false);
  assert.equal(visible(), '');
  reveal.word(id, 0, 0); assert.equal(visible(), 'One');
});

test('typing pause invalidates word, end, and error callbacks without revealing a suffix', () => {
  const { reveal, visible } = controller('One two three.');
  const id = reveal.start('speech');
  reveal.word(id, 0, 3); reveal.pause();
  assert.equal(reveal.word(id, 4, 3), false);
  assert.equal(reveal.finish(id), false);
  assert.equal(reveal.fail(id), false);
  assert.equal(visible(), 'One');
  assert.equal(reveal.snapshot().active, false);
});

test('Replay resets the prefix and rejects every callback from the previous run', () => {
  const { reveal, visible } = controller('One two three.');
  const first = reveal.start('speech'); reveal.word(first, 4, 3);
  const second = reveal.start('speech');
  assert.notEqual(first, second); assert.equal(visible(), '');
  reveal.word(first, 8, 5); reveal.finish(first); reveal.fail(first);
  assert.equal(visible(), ''); assert.equal(reveal.snapshot().requestId, second);
  reveal.word(second, 0, 3); assert.equal(visible(), 'One');
});

test('silent reveal paces at 220 words per minute and pause cancels pending and already-queued ticks', () => {
  const { reveal, time, visible } = controller('One — two three.');
  reveal.start('silent'); assert.equal(visible(), '');
  assert.equal(time.delay, 60000 / 220);
  time.next(); assert.equal(visible(), 'One');
  time.next(); assert.equal(visible(), 'One — two');
  const queued = time.lastId; reveal.pause();
  assert.equal(time.size, 0); time.late(queued);
  assert.equal(visible(), 'One — two');
});

test('silent continuation preserves visible words and a new question rejects an old timer', () => {
  const { reveal, time, visible } = controller('One two three.');
  const id = reveal.start('speech'); reveal.word(id, 0, 3);
  reveal.start('silent', { reset: false }); time.next(); assert.equal(visible(), 'One two');
  const queued = time.lastId; reveal.load('New question.');
  time.late(queued); reveal.finish(id); assert.equal(visible(), '');
  reveal.start('silent'); time.next(); assert.equal(visible(), 'New');
  time.next(); assert.equal(visible(), 'New question.'); assert.equal(reveal.snapshot().active, false);
});

test('voices without boundary events keep future text hidden until a natural end', () => {
  const { reveal, visible } = controller('One two three.');
  const id = reveal.start('speech'); assert.equal(visible(), '');
  reveal.finish(id); assert.equal(visible(), 'One two three.');
});

test('final grading can reveal the whole question and invalidates delayed speech events', () => {
  const { reveal, visible } = controller('One two three.');
  const id = reveal.start('speech'); reveal.word(id, 0, 3); reveal.revealAll();
  assert.equal(visible(), 'One two three.'); assert.equal(reveal.snapshot().active, false);
  assert.equal(reveal.word(id, 4, 3), false);
});

class Element {
  constructor() { this.textContent = ''; this.value = ''; this.checked = false; this.disabled = false; this.readOnly = false; this.hidden = false; this.listeners = new Map(); this.children = []; }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  emit(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn({ preventDefault() {}, ...event }); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  focus() {}
  setSelectionRange() {}
}
async function frontend({ native = true, readAloud = true, verdict = 'prompt', questionForRequest, preferenceForRequest } = {}) {
  const elements = new Map(), nativeEvents = new Element(), windowEvents = new Element(), time = clock(), messages = [], utterances = [], preparations = [], playbacks = [], requests = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const question = { id: 'q1', text: 'First clue; second clue. Final clue.', topic: 'Science', level: 'high', source: { provider: 'Fixture' } };
  let serial = 0, questionRequests = 0;
  const window = { addEventListener: windowEvents.addEventListener.bind(windowEvents), crypto: { randomUUID: () => `run-${++serial}` }, speechSynthesis: { cancel() {}, speak(value) { utterances.push(value); } } };
  if (native) window.chrome = { webview: { postMessage(message) { messages.push(message); }, addEventListener: nativeEvents.addEventListener.bind(nativeEvents) } };
  const document = { getElementById: get, createElement: () => new Element(), addEventListener() {}, querySelectorAll(selector) {
    const name = selector.match(/name="([^"]+)"/)?.[1];
    return ['topics', 'levels'].flatMap(id => get(id).children.flatMap(label => label.children)).filter(input => input.name === name && input.checked);
  } };
  const fetch = async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : undefined });
    let value;
    if (url === '/api/state') value = { csrfToken: 'test', stats: {}, preferences: { topics: ['Science'], levels: ['high'], readAloud } };
    else if (url.startsWith('/api/question?')) value = questionForRequest ? await questionForRequest({ index: ++questionRequests, url, signal: options.signal, question }) : { question };
    else if (url === '/api/answer') value = { verdict, answer: 'Correct answer', stats: { answered: verdict === 'prompt' ? 0 : 1, correct: 1 } };
    else if (url === '/api/prepare-next') { preparations.push(JSON.parse(options.body)); value = { prepared: true }; }
    else if (url === '/api/playback') { playbacks.push(JSON.parse(options.body)); value = { accepted: true }; }
    else if (url === '/api/preferences' && preferenceForRequest) value = await preferenceForRequest(JSON.parse(options.body));
    else value = JSON.parse(options.body);
    return { ok: true, async json() { return value; } };
  };
  const context = { window, document, fetch, AbortController, URLSearchParams, setTimeout: time.setTimer, clearTimeout: time.clearTimer, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } };
  vm.runInNewContext(source, context);
  const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  await settle();
  return { get, question, time, messages, utterances, preparations, playbacks, requests, settle, windowEvents,
    select(name, values) { for (const input of get(name === 'topic' ? 'topics' : 'levels').children.flatMap(label => label.children)) if (input.name === name) input.checked = values.includes(input.value); },
    word(id, position, count = 1) { nativeEvents.emit('message', { data: { type: 'speech-word', requestId: id, position, count } }); },
    ended(id) { nativeEvents.emit('message', { data: { type: 'speech-ended', requestId: id } }); },
    error(id) { nativeEvents.emit('message', { data: { type: 'speech-error', requestId: id } }); },
  };
}

test('native UI stays blank, synchronizes words, freezes before typing, and ignores cancelled speech', async () => {
  const ui = await frontend();
  const speak = ui.messages.findLast(message => message.action === 'speak');
  assert.equal(speak.text, ui.question.text); assert.equal(typeof speak.requestId, 'string');
  assert.equal(ui.get('question').textContent, '');
  ui.word(speak.requestId, 0, 5); assert.equal(ui.get('question').textContent, 'First');
  ui.get('answer').emit('beforeinput'); ui.get('answer').value = 'x';
  assert.equal(ui.messages.at(-1).action, 'stop');
  ui.word(speak.requestId, 12, 6); ui.ended(speak.requestId);
  assert.equal(ui.get('question').textContent, 'First');
  ui.get('answer').value = ''; ui.get('answer').emit('input');
  assert.equal(ui.get('question').textContent, 'First');
  assert.equal(ui.get('stop-reading').hidden, true);
});

test('explicit Replay clears the visible prefix and accepts only the new native request', async () => {
  const ui = await frontend();
  const first = ui.messages.findLast(message => message.action === 'speak'); ui.word(first.requestId, 0, 5);
  ui.get('answer').emit('compositionstart'); ui.get('read-question').emit('click');
  const second = ui.messages.findLast(message => message.action === 'speak');
  assert.notEqual(first.requestId, second.requestId); assert.equal(ui.get('question').textContent, '');
  ui.ended(first.requestId); assert.equal(ui.get('question').textContent, '');
  ui.word(second.requestId, 6, 4); assert.equal(ui.get('question').textContent, 'First clue;');
});

test('silent UI starts blank, pauses on the first key, and does not resume on delete or preference changes', async () => {
  const ui = await frontend({ readAloud: false });
  assert.equal(ui.messages.some(message => message.action === 'speak'), false);
  assert.equal(ui.get('question').textContent, ''); ui.time.next(); assert.equal(ui.get('question').textContent, 'First');
  ui.get('answer').emit('keydown', { key: 'a' });
  assert.equal(ui.time.size, 0);
  ui.get('answer').emit('input'); ui.get('read-aloud').checked = true; ui.get('read-aloud').emit('change'); await ui.settle();
  assert.equal(ui.messages.some(message => message.action === 'speak'), false);
  assert.equal(ui.get('question').textContent, 'First');
});

test('a prompt preserves the frozen prefix, while a final verdict reveals the question for review', async () => {
  for (const verdict of ['prompt', 'correct', 'incorrect']) {
    const ui = await frontend({ verdict });
    const speak = ui.messages.findLast(message => message.action === 'speak'); ui.word(speak.requestId, 0, 5);
    ui.get('answer').value = 'attempt'; ui.get('answer-form').emit('submit'); await ui.settle();
    assert.equal(ui.get('question').textContent, verdict === 'prompt' ? 'First' : ui.question.text);
  }
});

test('browser fallback uses boundary offsets and late end events cannot reveal text after typing', async () => {
  const ui = await frontend({ native: false });
  assert.equal(ui.get('question').textContent, ''); assert.equal(ui.utterances.length, 0);
  ui.get('read-question').emit('click');
  const utterance = ui.utterances.at(-1); assert.equal(utterance.text, ui.question.text);
  utterance.onboundary({ name: 'word', charIndex: 0, charLength: 0 }); assert.equal(ui.get('question').textContent, 'First');
  ui.get('answer').emit('beforeinput'); utterance.onboundary({ name: 'word', charIndex: 6, charLength: 4 }); utterance.onend();
  assert.equal(ui.get('question').textContent, 'First');
});

test('each loaded question immediately warms its successor without revealing future words',async()=>{
  const ui=await frontend({ questionForRequest: ({ index, question }) => ({ question: { ...question, id: `q${index}`, text: index === 1 ? question.text : 'Another hidden clue.' } }) });
  assert.deepEqual(ui.preparations,[{topics:['Science'],levels:['high'],warmSpeech:true}]);
  assert.equal(ui.get('question').textContent,'');
  assert.deepEqual(ui.playbacks,[{id:'q1',active:true,sequence:1}]);
  assert.ok(ui.requests.findIndex(item=>item.url==='/api/playback')<ui.requests.findIndex(item=>item.url==='/api/prepare-next'));
  ui.get('skip-question').emit('click');await ui.settle();
  assert.equal(ui.preparations.length,2);assert.equal(ui.preparations[1].warmSpeech,true);
  assert.equal(ui.messages.findLast(message=>message.action==='speak').text,'Another hidden clue.');
  assert.equal(ui.get('question').textContent,'');
  assert.deepEqual(ui.playbacks.map(item=>[item.id,item.active]),[['q1',true],['q1',false],['q2',true]]);
});

test('typing releases current voice priority and repeated input does not duplicate warm requests',async()=>{
  const ui=await frontend();
  assert.deepEqual(ui.preparations,[{topics:['Science'],levels:['high'],warmSpeech:true}]);
  const current=ui.messages.findLast(message=>message.action==='speak');ui.word(current.requestId,0,5);
  assert.equal(ui.preparations.length,1);
  ui.get('answer').emit('beforeinput');await ui.settle();
  assert.equal(ui.preparations.length,1);
  assert.deepEqual(ui.playbacks.map(item=>item.active),[true,false]);
  assert.equal(ui.get('question').textContent,'First');
  ui.get('answer').emit('input');ui.get('answer').emit('keydown',{key:'x'});await ui.settle();
  assert.equal(ui.preparations.length,1);assert.equal(ui.playbacks.length,2);
});

test('natural speech completion releases priority, while stale ends cannot release a replay',async()=>{
  const ui=await frontend();const current=ui.messages.findLast(message=>message.action==='speak');
  ui.ended('old-request');await ui.settle();assert.equal(ui.playbacks.length,1);
  ui.ended(current.requestId);await ui.settle();assert.deepEqual(ui.playbacks.map(item=>item.active),[true,false]);
  ui.get('read-question').emit('click');await ui.settle();
  const replay=ui.messages.findLast(message=>message.action==='speak');
  assert.notEqual(replay.requestId,current.requestId);
  assert.deepEqual(ui.playbacks.map(item=>item.active),[true,false,true]);
  ui.ended(current.requestId);ui.error(current.requestId);await ui.settle();
  assert.equal(ui.playbacks.at(-1).active,true);assert.equal(ui.playbacks.length,3);
  ui.ended(replay.requestId);await ui.settle();
  assert.deepEqual(ui.playbacks.map(item=>item.sequence),[1,2,3,4]);
  assert.equal(ui.playbacks.at(-1).active,false);assert.equal(ui.preparations.length,1);
});

test('Replay keeps active voice priority while stop, errors, and unload release it',async()=>{
  const ui=await frontend();
  ui.get('read-question').emit('click');await ui.settle();
  assert.deepEqual(ui.playbacks.map(item=>item.active),[true]);
  const replay=ui.messages.findLast(message=>message.action==='speak');ui.error(replay.requestId);await ui.settle();
  assert.deepEqual(ui.playbacks.map(item=>item.active),[true,false]);
  ui.get('read-question').emit('click');await ui.settle();ui.get('stop-reading').emit('click');await ui.settle();
  ui.get('read-question').emit('click');await ui.settle();ui.windowEvents.emit('beforeunload');await ui.settle();
  assert.deepEqual(ui.playbacks.map(item=>item.active),[true,false,true,false,true,false]);
  assert.deepEqual(ui.playbacks.map(item=>item.sequence),[1,2,3,4,5,6]);
});

test('silent reading and a disabled voice never request future speech',async()=>{
  const silent=await frontend({readAloud:false});silent.get('answer').emit('beforeinput');await silent.settle();
  assert.equal(silent.preparations.some(item=>item.warmSpeech),false);
  assert.deepEqual(silent.playbacks.map(item=>item.active),[false]);
  const ui=await frontend();ui.get('read-aloud').checked=false;ui.get('read-aloud').emit('change');await ui.settle();
  assert.deepEqual(ui.playbacks.map(item=>item.active),[true,false]);
});

test('turning Read aloud back on re-arms the queue after saving preferences without resuming a typed answer',async()=>{
  const ui=await frontend();const current=ui.messages.findLast(message=>message.action==='speak');
  ui.word(current.requestId,0,5);ui.get('answer').emit('beforeinput');
  ui.get('read-aloud').checked=false;ui.get('read-aloud').emit('change');await ui.settle();
  assert.equal(ui.preparations.length,1);
  ui.get('read-aloud').checked=true;ui.get('read-aloud').emit('change');await ui.settle();
  assert.equal(ui.preparations.length,2);assert.equal(ui.preparations[1].warmSpeech,true);
  const lastPreference=ui.requests.findLastIndex(item=>item.url==='/api/preferences');
  const lastWarm=ui.requests.findLastIndex(item=>item.url==='/api/prepare-next');
  assert.ok(lastWarm>lastPreference);
  assert.equal(ui.messages.filter(message=>message.action==='speak').length,1);
  assert.equal(ui.get('question').textContent,'First');
});

test('rapid filter changes ignore old question replies and warm only the latest selected filters',async()=>{
  const waiting=[];
  const ui=await frontend({ questionForRequest: ({ index, question, url, signal }) => index===1 ? { question } : new Promise(resolve=>waiting.push({resolve,url,signal})) });
  ui.select('topic',['History']);ui.get('topics').emit('change');await ui.settle();
  ui.select('topic',['Literature']);ui.get('topics').emit('change');await ui.settle();
  assert.equal(waiting.length,2);assert.equal(waiting[0].signal.aborted,true);
  waiting[1].resolve({question:{...ui.question,id:'latest',topic:'Literature',text:'Latest hidden clue.'}});await ui.settle();
  waiting[0].resolve({question:{...ui.question,id:'stale',topic:'History',text:'Stale hidden clue.'}});await ui.settle();
  assert.deepEqual(ui.preparations.map(item=>item.topics),[['Science'],['Literature']]);
  assert.equal(ui.messages.findLast(message=>message.action==='speak').text,'Latest hidden clue.');
  assert.equal(ui.get('question').textContent,'');
  assert.equal(ui.playbacks.at(-1).id,'latest');
  assert.equal(ui.playbacks.some(item=>item.id==='stale'),false);
  assert.deepEqual(ui.playbacks.map(item=>item.sequence),[1,2,3]);
});

test('filter questions wait for pending preference saves and superseded filters never issue a request',async()=>{
  const pending=[];
  const ui=await frontend({
    preferenceForRequest: snapshot => new Promise(resolve=>pending.push({snapshot,resolve})),
    questionForRequest: ({index,question,url}) => ({question:{...question,id:`q${index}`,topic:new URLSearchParams(url.split('?')[1]).get('topics')}}),
  });
  ui.select('topic',['History']);ui.get('topics').emit('change');await ui.settle();
  ui.select('topic',['Literature']);ui.get('topics').emit('change');await ui.settle();
  assert.equal(pending.length,1);assert.deepEqual(pending[0].snapshot.topics,['History']);
  assert.equal(ui.requests.filter(item=>item.url.startsWith('/api/question?')).length,1);
  pending[0].resolve({saved:true});await ui.settle();
  assert.equal(pending.length,2);assert.deepEqual(pending[1].snapshot.topics,['Literature']);
  assert.equal(ui.requests.filter(item=>item.url.startsWith('/api/question?')).length,1);
  pending[1].resolve({saved:true});await ui.settle();
  const questions=ui.requests.filter(item=>item.url.startsWith('/api/question?'));
  assert.equal(questions.length,2);assert.equal(new URLSearchParams(questions[1].url.split('?')[1]).get('topics'),'Literature');
  assert.deepEqual(ui.preparations.map(item=>item.topics),[['Science'],['Literature']]);
  assert.equal(ui.playbacks.at(-1).id,'q2');
});
