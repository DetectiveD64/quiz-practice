import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, cleanAnswerline, decodeEntities, levelForDifficulty, LEVELS, TOPICS, getCatalog, randomQuestions, SourceError } from '../src/sources.mjs';

const now = () => new Date('2026-10-18T16:00:00Z');
const noSleep = async () => {};
const response = (value, options) => new Response(JSON.stringify(value), options);
// Synthetic fixture text only; tests do not copy archive questions.
const question = (changes = {}) => ({
  _id: 'question1', question: '<b>Fixture</b> question about &alpha; and 10<sup>2</sup>.',
  answer: '<b><u>Fixture answer</u></b> [accept a provided alternative]',
  category: 'Science', subcategory: 'Physics', difficulty: 3, number: 7,
  packet: { _id: 'packet1', name: 'Fixture packet', number: 2 },
  set: { _id: 'set1', name: '2026 Synthetic Test Set', year: 2026, standard: true }, ...changes,
});
const catalog = () => ({ setList: [
  { _id: 'set1', setName: '2026 Synthetic Test Set', year: 2026, difficulty: 3,
    standard: true, packetsCount: 2, tossupsCount: 40, bonusesCount: 38 },
  { _id: 'set2', setName: '2025 Another Fixture', year: 2025, difficulty: 6,
    standard: true, packetsCount: 1, tossupsCount: 20, bonusesCount: 20 },
] });

test('HTML is converted to inert text with scientific notation and answer instructions', () => {
  assert.equal(cleanText('<p>One &amp; two</p><script>alert(1)</script><style>x</style><p>10<sup>−4</sup> H<sub>2</sub>O &le; &pi;</p>'),
    'One & two 10^(−4) H_(2)O ≤ π');
  assert.equal(cleanText('&lt;img src=x onerror=alert(1)&gt;<b>Safe</b> &amp;#x3b1;'), 'Safe α');
  assert.equal(cleanText('<u>Answer</u> [accept X; do not accept Y]'), 'Answer [accept X; do not accept Y]');
  assert.equal(cleanText('x < 3 and y > 1'), 'x < 3 and y > 1');
  assert.equal(cleanText('hello<script>unfinished'), 'hello');
  assert.equal(decodeEntities('&#x1f600; &#0; &unknown;'), '😀 � &unknown;');
  assert.equal(cleanAnswerline('<b data-test="x">Ada <u onclick="x">Lovelace</u></b> [accept <i>Lovelace</i>]<img src=x><script>x</script>'),
    '<b>Ada <u>Lovelace</u></b> [accept <i>Lovelace</i>]');
});

test('difficulty groups cover academic scale 1–10 and exclude 0 Pop Culture', () => {
  assert.deepEqual(LEVELS.map(level => level.id), ['middle', 'high', 'college', 'open']);
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => levelForDifficulty(i + 1)),
    ['middle', 'high', 'high', 'high', 'high', 'college', 'college', 'college', 'college', 'open']);
  for (const value of [0, 11, 2.5, '3', null]) assert.equal(levelForDifficulty(value), null);
  assert.equal(TOPICS.length, 10);
});

test('random questions use fixed public endpoint and exact filters, retaining backend answerline', async () => {
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://www.qbreader.org');
    assert.equal(parsed.pathname, '/api/random-tossup');
    assert.equal(parsed.searchParams.get('number'), '2');
    assert.equal(parsed.searchParams.get('categories'), 'Science');
    assert.equal(parsed.searchParams.get('difficulties'), '2,3,4,5');
    assert.equal(parsed.searchParams.get('standardOnly'), 'true');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return response({ tossups: [question(), question()] });
  };
  const result = await randomQuestions({ topics: ['Science'], levels: ['high'], count: 2, fetchImpl, now, sleepImpl: noSleep });
  assert.equal(result.questions.length, 1);
  const item = result.questions[0];
  assert.equal(item.text, 'Fixture question about α and 10^(2).');
  assert.equal(item.answerline, '<b><u>Fixture answer</u></b> [accept a provided alternative]');
  assert.equal(item.answerText, 'Fixture answer [accept a provided alternative]');
  assert.equal(item.level, 'high');
  assert.equal(item.source.provider, 'QBReader');
  assert.equal(item.source.packetNumber, 2);
  assert.equal(item.source.questionNumber, 7);
  assert.equal(item.fetchedAt, '2026-10-18T16:00:00.000Z');
  assert.equal(result.noMatches, false);
  assert.equal(Object.hasOwn(item, 'answer'), false);
});

test('Other expands to canonical academic/current-events categories and rechecks returned filters', async () => {
  const fetchImpl = async url => {
    assert.equal(new URL(url).searchParams.get('categories'), 'Other Academic,Current Events');
    return response({ tossups: [question({ _id: 'other', category: 'Current Events', difficulty: 10 }), question()] });
  };
  const result = await randomQuestions({ topics: ['Other'], levels: ['open'], fetchImpl, sleepImpl: noSleep });
  assert.deepEqual(result.questions.map(item => [item.id, item.topic]), [['other', 'Other']]);
});

test('empty filters and upstream no matches stay empty without invented fallback questions', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response({ tossups: [] }); };
  assert.equal((await randomQuestions({ topics: [], fetchImpl })).noMatches, true);
  assert.equal((await randomQuestions({ levels: [], fetchImpl })).questions.length, 0);
  assert.equal(calls, 0);
  assert.equal((await randomQuestions({ topics: ['Science'], levels: ['middle'], fetchImpl })).noMatches, true);
  assert.equal(calls, 1);
});

test('invalid filters and oversized batches are rejected before a request', async () => {
  const fetchImpl = () => { throw new Error('Must not request'); };
  for (const options of [{ topics: ['NAQT'] }, { levels: ['unknown'] }, { count: 21 }, { count: 0 }, { count: 2.5 }]) {
    await assert.rejects(randomQuestions({ ...options, fetchImpl }), SourceError);
  }
});

test('sanitized upstream fields are preferred, while malformed questions are excluded', async () => {
  const fetchImpl = async () => response({ tossups: [
    question({ _id: 'good', question_sanitized: 'Plain fixture question', answer_sanitized: 'Plain answer [accept A]' }),
    question({ _id: 'bad', answer: '' }), question({ _id: 'unlabeled', difficulty: 0 }),
    question({ _id: 'wrongformat', set: { name: 'Fixture', standard: false } }),
  ] });
  const { questions } = await randomQuestions({ fetchImpl });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].text, 'Plain fixture question');
  assert.equal(questions[0].answerText, 'Plain answer [accept A]');
  assert.match(questions[0].answerline, /<u>Fixture answer<\/u>/);
});

test('catalog returns counted metadata only and caches a protected copy', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    assert.equal(url, 'https://www.qbreader.org/api/set-list?expand=true&includeCounts=true');
    return response(catalog());
  };
  const first = await getCatalog({ fetchImpl, now });
  assert.deepEqual(first.totals, { sets: 2, packets: 3, tossups: 60, bonuses: 58 });
  first.sets[0].setName = 'Changed externally';
  assert.equal((await getCatalog({ fetchImpl })).sets[0].setName, '2026 Synthetic Test Set');
  assert.equal(calls, 1);
  await getCatalog({ fetchImpl, force: true, sleepImpl: noSleep });
  assert.equal(calls, 2);
});

test('retry is bounded to one attempt and respects short Retry-After', async () => {
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => ++calls === 1
    ? response({}, { status: 429, headers: { 'Retry-After': '2' } }) : response({ tossups: [question()] });
  const result = await randomQuestions({ fetchImpl, sleepImpl: async ms => waits.push(ms) });
  assert.equal(result.questions.length, 1);
  assert.equal(calls, 2);
  assert.ok(waits.includes(2000));
  let longCalls = 0;
  await assert.rejects(randomQuestions({ fetchImpl: async () => { longCalls++; return response({}, { status: 429, headers: { 'Retry-After': '60' } }); }, sleepImpl: noSleep }),
    error => error.code === 'RATE_LIMITED');
  assert.equal(longCalls, 1);
  let datedCalls = 0;
  await assert.rejects(randomQuestions({ fetchImpl: async () => { datedCalls++; return response({}, {
    status: 503, headers: { 'Retry-After': new Date(Date.now() + 60000).toUTCString() },
  }); }, sleepImpl: noSleep }), error => error.code === 'HTTP_ERROR');
  assert.equal(datedCalls, 1);
});

test('source outages, invalid responses and unsafe redirects produce actionable errors', async () => {
  let networkCalls = 0;
  await assert.rejects(randomQuestions({ fetchImpl: async () => { networkCalls++; throw new Error('private network details'); }, sleepImpl: noSleep }),
    error => error.code === 'NETWORK_ERROR' && !error.message.includes('private'));
  assert.equal(networkCalls, 2);
  await assert.rejects(randomQuestions({ fetchImpl: async () => response({ anything: [] }) }), error => error.code === 'INVALID_RESPONSE');
  await assert.rejects(randomQuestions({ fetchImpl: async () => response({ tossups: [question({ answer: '' })] }) }), error => error.code === 'INVALID_RESPONSE');
  await assert.rejects(randomQuestions({ fetchImpl: async () => new Response('not json') }), error => error.code === 'INVALID_RESPONSE');
  const fetchImpl = async () => ({ ok: true, url: 'https://evil.example/api/random-tossup' });
  await assert.rejects(randomQuestions({ fetchImpl }), error => error.code === 'INVALID_SOURCE');
});

test('request deadline also bounds a fetch implementation that does not handle abort', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; return new Promise(() => {}); };
  await assert.rejects(randomQuestions({ fetchImpl, timeoutMs: 5, sleepImpl: noSleep }), error => error.code === 'TIMEOUT');
  assert.equal(calls, 2);
});
