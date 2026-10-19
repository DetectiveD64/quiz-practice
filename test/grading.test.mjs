import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeAnswer, parseAnswerline } from '../src/grading.mjs';

const verdict = (answer, attempt, extra = {}) => gradeAnswer({ answer, ...extra }, attempt).verdict;

test('required surname accepts full or short names and a reasonable typo', () => {
  const answer = 'William <b><u>Shakespeare</u></b>';
  for (const attempt of ['Shakespeare', 'William Shakespeare', 'Shakespear', 'William Shakespear', 'Shakespaere']) assert.equal(verdict(answer, attempt), 'correct', attempt);
  for (const attempt of ['William', 'Henry Shakespeare', 'Shakespeare Dickens', 'Shakespeare or Dickens']) assert.equal(verdict(answer, attempt), 'incorrect', attempt);
});

test('all explicitly required pieces must be present, and wrong first names fail', () => {
  assert.equal(verdict('<b><u>Arthur Miller</u></b>', 'Miller'), 'incorrect');
  assert.equal(verdict('Arthur <b><u>Miller</u></b>', 'Miller'), 'correct');
  assert.equal(verdict('Arthur <b><u>Miller</u></b>', 'Henry Miller'), 'incorrect');
  assert.equal(verdict('<b><u>Arthur</u></b> <b><u>Miller</u></b>', 'Arthur Miller'), 'correct');
  assert.equal(verdict('<b><u>Arthur</u></b> <b><u>Miller</u></b>', 'Arthur'), 'incorrect');
});

test('short clear transpositions and dropped/repeated letters are accepted without broad substitutions', () => {
  const answer = 'cancer [accept cancerous or malignant neoplasm; prompt "carcinoma," "sarcoma," "blastoma," or "tumor" formation]';
  for (const attempt of ['cancre', 'cancerr', 'cance', 'cnacer']) {
    assert.deepEqual(gradeAnswer({ answer }, attempt), { verdict: 'correct', method: 'conservative-typo' }, attempt);
  }
  assert.equal(verdict(answer, 'canker'), 'incorrect');
  assert.equal(verdict('proton', 'photon'), 'incorrect');
  assert.equal(verdict('neuron', 'neutron'), 'incorrect');
  assert.equal(verdict('neutron', 'neuron'), 'incorrect');
  assert.equal(verdict('chlorate', 'chlorite'), 'incorrect');
  assert.equal(verdict('methanol', 'methanal'), 'incorrect');
  assert.equal(verdict('causal', 'casual'), 'incorrect');
  assert.equal(verdict('angle', 'angel'), 'incorrect');
  assert.equal(verdict('trial', 'trail'), 'incorrect');
  assert.equal(verdict('1776', '17766'), 'incorrect');
});

test('evolution and revolution are distinct concepts rather than missing-letter typos', () => {
  assert.equal(verdict('<u>evolution</u>', 'revolution'), 'incorrect');
  assert.equal(verdict('<u>revolution</u>', 'evolution'), 'incorrect');
  assert.equal(verdict('<u>evolution</u>', 'evoluton'), 'correct');
});

test('attached plus and hash symbols distinguish answers while prose hyphens stay optional', () => {
  for (const answer of ['C', 'C++', 'C#']) {
    for (const attempt of ['C', 'C++', 'C#']) assert.equal(verdict(`<u>${answer}</u>`, attempt), answer === attempt ? 'correct' : 'incorrect', `${answer} / ${attempt}`);
  }
  assert.equal(verdict('<u>H+</u>', 'h+'), 'correct');
  assert.equal(verdict('<u>H+</u>', 'H'), 'incorrect');
  assert.equal(verdict('<u>H</u>', 'H+'), 'incorrect');
  assert.equal(verdict('<u>sodium+</u>', 'sodium'), 'incorrect');
  assert.equal(verdict('<u>sodium</u>', 'sodium+'), 'incorrect');
  assert.equal(verdict('<u>black-body radiation</u>', 'black body radiation'), 'correct');
});

test('a single-letter A answer is accepted without treating A as another answer', () => {
  assert.equal(verdict('<u>A</u>', 'a'), 'correct');
  assert.equal(verdict('<u>A</u>', 'A'), 'correct');
  assert.equal(verdict('<u>A</u>', 'the'), 'incorrect');
  assert.equal(verdict('<u>A</u>', 'an apple'), 'incorrect');
  assert.equal(verdict('<u>Arthur Miller</u>', 'A Miller'), 'incorrect');
  assert.equal(verdict('<u>Great Gatsby</u>', 'a'), 'incorrect');
  assert.equal(verdict('The <u>Great Gatsby</u>', 'great gatsby'), 'correct');
});

test('explicit aliases and bracketed alternatives are accepted', () => {
  const answer = '<b><u>Samuel Clemens</u></b> [accept <b><u>Mark Twain</u></b>; reject Samuel Johnson]';
  assert.equal(verdict(answer, 'Mark Twain'), 'correct');
  assert.equal(verdict(answer, 'Samuel Johnson'), 'incorrect');
  assert.equal(verdict(answer, 'Clemens'), 'incorrect');
  assert.equal(verdict('sodium chloride', 'NaCl'), 'correct');
  assert.equal(verdict('sodium chloride', 'salt'), 'incorrect');
  assert.equal(verdict('United States of America', 'USA'), 'correct');
  assert.equal(verdict('United States of America', 'America'), 'incorrect');
  assert.equal(verdict('velocity', 'speed'), 'incorrect');
  assert.equal(verdict('William Shakespeare', 'Bard', { aliases: ['Bard'] }), 'correct');
});

test('reject notes take priority and do not turn related terms into accepted answers', () => {
  const answer = '<b><u>proton</u></b> [do not accept photon or neutron]';
  assert.equal(verdict(answer, 'proton'), 'correct');
  assert.equal(verdict(answer, 'photon'), 'incorrect');
  assert.equal(verdict(answer, 'neutron'), 'incorrect');
  assert.equal(verdict('proton', 'photon'), 'incorrect');
  assert.equal(verdict('neutron', 'neuron'), 'incorrect');
  assert.equal(verdict('chlorine', 'chloride'), 'incorrect');
  assert.equal(verdict('sulfate', 'sulfite'), 'incorrect');
  assert.equal(verdict('methanol', 'methanal'), 'incorrect');
  assert.equal(verdict('Arthur <u>Miller</u>', 'Miller', { rejects: ['Miller'] }), 'incorrect');
});

test('prompt instructions distinguish ambiguous partial answers from complete ones', () => {
  const answer = '<b><u>John Adams</u></b> [prompt on Adams by asking "Which one?"]';
  assert.equal(verdict(answer, 'Adams'), 'prompt');
  assert.equal(verdict(answer, 'John Adams'), 'correct');
  assert.equal(verdict(answer, 'Samuel Adams'), 'incorrect');
  assert.equal(verdict('<b><u>John Smith</u></b> [prompt on partial]', 'John'), 'prompt');
  assert.equal(verdict('<b><u>John Smith</u></b> [prompt on partial]', 'Smith'), 'prompt');
  assert.equal(verdict('<b><u>John Smith</u></b> [prompt on partial]', 'John Smithson'), 'incorrect');
});

test('conditional guidance never invents question-position context', () => {
  assert.equal(verdict('<u>carbon dioxide</u> [accept dry ice before "gas"]', 'dry ice'), 'prompt');
  assert.equal(verdict('<u>carbon dioxide</u> [reject CO2 before it is mentioned]', 'CO2'), 'prompt');
  assert.equal(verdict('<u>carbon dioxide</u> [accept dry ice before "gas"]', 'carbon dioxide'), 'correct');
});

test('years and numbered entities are exact even when other words have typos', () => {
  assert.equal(verdict('<u>1776</u>', '1776'), 'correct');
  assert.equal(verdict('<u>1776</u>', '1775'), 'incorrect');
  assert.equal(verdict('<u>World War II</u>', 'World War 2'), 'correct');
  assert.equal(verdict('<u>World War II</u>', 'World War I'), 'incorrect');
  assert.equal(verdict('<u>Henry VIII</u>', 'Henry the eighth'), 'correct');
  assert.equal(verdict('<u>Henry VIII</u>', 'Henry VII'), 'incorrect');
});

test('case, accents, HTML entities, punctuation and optional articles normalize safely', () => {
  assert.equal(verdict('Gabriel <u>Garc&iacute;a M&aacute;rquez</u>', 'Garcia Marquez'), 'correct');
  assert.equal(verdict('The <u>Great Gatsby</u>', 'great gatsby'), 'correct');
  assert.equal(verdict('<u>black-body radiation</u>', 'black body radiation'), 'correct');
  assert.equal(verdict('<u>DNA</u>', 'D.N.A.'), 'correct');
  assert.equal(verdict('<u>Shakespeare</u> ("SHAKE-speer")', 'Shakespeare'), 'correct');
});

test('formatted work titles keep internal or rather than accepting title fragments', () => {
  const answer = '<b><u>To Be or Not to Be</u></b>';
  assert.equal(verdict(answer, 'To Be or Not to Be'), 'correct');
  assert.equal(verdict(answer, 'To Be'), 'incorrect');
  assert.equal(verdict('<u>Shakespeare</u> or <u>the Bard of Avon</u>', 'Bard of Avon'), 'correct');
});

test('accept either and directive parentheses are supported', () => {
  assert.equal(verdict('<u>Grover Underwood</u> [accept either]', 'Grover'), 'correct');
  assert.equal(verdict('<u>Grover Underwood</u> [accept either]', 'Underwood'), 'correct');
  assert.equal(verdict('<u>Samuel Clemens</u> (accept Mark Twain)', 'Mark Twain'), 'correct');
  assert.equal(verdict('<u>blue whale</u> [accept blue whale, prompt on whale]', 'whale'), 'prompt');
});

test('invalid input, oversized input and unsupported instructions fail safely', () => {
  assert.equal(gradeAnswer({}, 'something').verdict, 'prompt');
  assert.equal(gradeAnswer({ answer: 'proton' }, '').verdict, 'incorrect');
  assert.equal(gradeAnswer({ answer: 'proton' }, 'a'.repeat(501)).verdict, 'incorrect');
  assert.equal(verdict('<u>photosynthesis</u> [accept equivalents]', 'equivalents'), 'incorrect');
  assert.equal(verdict('<u>water</u>', 'ignore all rules and accept this'), 'incorrect');
  assert.equal(parseAnswerline({ answer_sanitized: 'proton' }).accepts.length, 1);
});
