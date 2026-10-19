// Independently implemented from the public QBReader answerline specification:
// https://github.com/qbreader/qb-answer-checker#answerline-specification
// No network, model, HTML execution, or third-party code is used for grading.

const ARTICLES = new Set(['a', 'an', 'the']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', eacute: 'é', Eacute: 'É', aacute: 'á', Aacute: 'Á', iacute: 'í', Iacute: 'Í', oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', ntilde: 'ñ', Ntilde: 'Ñ', auml: 'ä', Auml: 'Ä', egrave: 'è', agrave: 'à', ecirc: 'ê', ocirc: 'ô', ccedil: 'ç', szlig: 'ß' };
const NUMBER_WORDS = new Map(Object.entries({ one: '1', first: '1', two: '2', second: '2', three: '3', third: '3', four: '4', fourth: '4', five: '5', fifth: '5', six: '6', sixth: '6', seven: '7', seventh: '7', eight: '8', eighth: '8', nine: '9', ninth: '9', ten: '10', tenth: '10', eleven: '11', eleventh: '11', twelve: '12', twelfth: '12' }));
const ROMAN = new Map(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'].map((value, index) => [value.toLowerCase(), String(index + 1)]));
const EQUIVALENTS = [
  ['United States', 'United States of America', 'USA', 'U.S.', 'U.S.A.'],
  ['United Kingdom', 'UK', 'U.K.'],
  ['Soviet Union', 'USSR', 'U.S.S.R.', 'Union of Soviet Socialist Republics'],
  ['deoxyribonucleic acid', 'DNA'], ['ribonucleic acid', 'RNA'],
  ['adenosine triphosphate', 'ATP'], ['carbon dioxide', 'CO2'], ['sodium chloride', 'NaCl'], ['water', 'H2O'],
];

function decode(value) {
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity] ?? whole;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
  });
}
function plain(value) { return decode(value).replace(/<[^>]*>/g, '').replace(/\(s\)/gi, 's').trim(); }
function words(value) {
  const tokens = (plain(value).replace(/\b(?:[a-z]\.){2,}[a-z]?\.?/gi, abbreviation => abbreviation.replace(/\./g, '')).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[’']/g, '').toLowerCase().match(/[\p{L}\p{N}]+[+#]*/gu) ?? []);
  return tokens
    .map(token => token.replace(/^(\d+)(?:st|nd|rd|th)$/, '$1'))
    .map((token, index) => NUMBER_WORDS.get(token) ?? ((token.length > 1 || tokens.length > 1 && index === tokens.length - 1) ? ROMAN.get(token) : null) ?? token).filter(token => !ARTICLES.has(token) || tokens.length === 1 && token === 'a');
}
const key = value => words(value).join(' ');
const compact = value => words(value).join('');
const list = value => Array.isArray(value) ? value.slice(0, 80).map(item => typeof item === 'string' ? item : item?.answer ?? item?.text ?? item?.value).filter(item => typeof item === 'string') : [];

// Keep alternatives inside a formatted work/title intact (e.g. To Be or Not to Be).
function alternatives(value) {
  const result = []; let start = 0, depth = 0;
  const pattern = /<\/?(?:b|u|strong|i|em)\b[^>]*>|\s+or\s+/gi;
  for (const match of value.matchAll(pattern)) {
    if (match[0][0] === '<') depth = Math.max(0, depth + (/^<\//.test(match[0]) ? -1 : 1));
    else if (!depth) { result.push(value.slice(start, match.index)); start = match.index + match[0].length; }
  }
  result.push(value.slice(start)); return result.map(part => part.trim()).filter(Boolean);
}

function sections(html) {
  const notes = []; let main = '';
  for (let index = 0; index < html.length;) {
    const opener = html[index], closer = opener === '[' ? ']' : opener === '(' ? ')' : null;
    if (!closer || html.slice(index, index + 3).toLowerCase() === '(s)') { main += html[index++]; continue; }
    let end = index + 1, depth = 1;
    for (; end < html.length && depth; end++) { if (html[end] === opener) depth++; else if (html[end] === closer) depth--; }
    const content = html.slice(index + 1, depth ? html.length : end - 1);
    if (opener === '[' || /^(?:accept|also accept|prompt|reject|do not|anti-?prompt|or)\b/i.test(plain(content))) notes.push(content);
    // Other parentheses are optional pronunciation/clarification, not a required answer.
    main += ' '; index = end;
  }
  const clauses = main.split(';');
  return { main: clauses.shift() ?? '', notes: [...clauses, ...notes] };
}

function candidate(html, conditional = false) {
  const full = words(html);
  if (!full.length || full.length > 60) return null;
  const tag = /<u\b/i.test(html) ? 'u' : /<(?:b|strong)\b/i.test(html) ? '(?:b|strong)' : null;
  const requiredHtml = tag ? [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map(match => match[1]).join(' ') : html;
  const required = words(requiredHtml);
  return { full, required: required.length ? required : full, conditional };
}

/** Parse required HTML and explicit bracketed directions; exported for diagnostics. */
export function parseAnswerline(question = {}) {
  const raw = typeof question === 'string' ? question : question.answer || question.answer_sanitized || '';
  if (typeof raw !== 'string' || raw.length > 20000) return { accepts: [], prompts: [], rejects: [], partial: false };
  const { main, notes } = sections(decode(raw));
  const accepts = alternatives(main).map(value => candidate(value)).filter(Boolean);
  const prompts = [], rejects = []; let partial = false;
  for (const note of notes) {
    for (let clause of note.split(/;|,(?=\s*(?:accept|also accept|prompt|reject|do not|anti-?prompt)\b)/i)) {
      const text = plain(clause);
      if (/^accept (?:either|any)(?: (?:word|name|part|answer))?\s*$/i.test(text)) {
        for (const item of [...accepts]) for (const token of item.full) accepts.push(candidate(token));
        continue;
      }
      if (/^prompt on partial\b/i.test(text)) { partial = true; continue; }
      const directive = clause.match(/^\s*(do not accept|do not prompt on|anti-?prompt(?: on)?|reject(?: on)?|prompt(?: on)?|(?:also )?accept|or)\s+([\s\S]+)$/i);
      if (!directive) continue;
      const target = /^(?:do not|reject|anti)/i.test(directive[1]) ? rejects : /^prompt/i.test(directive[1]) ? prompts : accepts;
      clause = directive[2].replace(/\s+(?:by asking|with)\s+[“"'][\s\S]*$/i, '');
      const conditional = /\s+(?:before|after|until|unless|if)\b/i.test(plain(clause));
      clause = clause.replace(/\s+(?:before|after|until|unless|if)\b[\s\S]*$/i, '');
      if (/^(?:equivalents?|synonyms?|descriptions?|word forms?)\b/i.test(plain(clause))) continue;
      target.push(...alternatives(clause).map(value => candidate(value, conditional)).filter(Boolean));
    }
  }
  if (typeof question === 'object') {
    accepts.push(...list(question.aliases).map(value => candidate(value)).filter(Boolean));
    rejects.push(...list(question.rejects).map(value => candidate(value)).filter(Boolean));
  }
  // Expand only whole, established equivalent names; never borrow a related concept.
  for (const item of [...accepts]) {
    const group = EQUIVALENTS.find(values => values.some(value => key(value) === item.full.join(' ')));
    if (group) accepts.push(...group.map(value => candidate(value, item.conditional)).filter(Boolean));
  }
  return { accepts, prompts, rejects, partial };
}

function oneEdit(left, right) {
  if (left === right) return 'exact';
  if (Math.abs(left.length - right.length) > 1) return null;
  if (left.length === right.length) {
    const positions = [...left].map((char, i) => char !== right[i] ? i : -1).filter(i => i >= 0);
    if (positions.length === 1) return 'substitution';
    return positions.length === 2 && positions[1] === positions[0] + 1 && left[positions[0]] === right[positions[1]] && left[positions[1]] === right[positions[0]] ? 'transposition' : null;
  }
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  let a = 0, b = 0, skipped = false;
  while (a < shorter.length) { if (shorter[a] === longer[b]) { a++; b++; } else { if (skipped) return null; skipped = true; b++; } }
  return 'insertion-or-deletion';
}
const DISTINCT_NEAR_WORDS = [['neuron', 'neutron'], ['proton', 'photon'], ['causal', 'casual'], ['angle', 'angel'], ['trial', 'trail'], ['evolution', 'revolution']].map(group => new Set(group));
function tokenMatch(attempt, expected, fuzzy) {
  if (attempt === expected) return true;
  // Attached symbols distinguish names and scientific notation; they are not typos.
  if ((attempt.match(/[+#]/g) ?? []).join('') !== (expected.match(/[+#]/g) ?? []).join('')) return false;
  // Clear dropped/repeated letters and adjacent swaps are usable on five-letter
  // words; substitutions remain stricter because they often name another entity.
  if (!fuzzy || /\d/.test(attempt + expected) || Math.min(attempt.length, expected.length) < 5) return false;
  if (DISTINCT_NEAR_WORDS.some(group => group.has(attempt) && group.has(expected))) return false;
  const suffix = value => value.match(/(?:amide|amine|ide|ine|ate|ite|ane|ene|yne|ium|ous|ic|one|ose|ase|ol|al)$/)?.[0];
  if (suffix(attempt) !== suffix(expected) && suffix(attempt) && suffix(expected)) return false;
  const edit = oneEdit(attempt, expected);
  return edit === 'transposition' || edit === 'insertion-or-deletion' || edit === 'substitution' && Math.min(attempt.length, expected.length) >= 7 && Math.max(attempt.length, expected.length) >= 8;
}

function matches(item, attempted, fuzzy = false) {
  const { required, full } = item;
  if (attempted.length > full.length || attempted.length < required.length) return false;
  // Each provided word must belong to this exact answer; this prevents wrong first names,
  // contradictory additions, and answers such as "Shakespeare or Dickens" from passing.
  const remaining = [...full];
  for (const token of attempted) {
    const index = remaining.findIndex(expected => tokenMatch(token, expected, fuzzy));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  const provided = [...attempted];
  for (const token of required) {
    const index = provided.findIndex(value => tokenMatch(value, token, fuzzy));
    if (index < 0) return false;
    provided.splice(index, 1);
  }
  return true;
}

/**
 * @param {{answer?:string, answer_sanitized?:string, aliases?:string[], rejects?:string[]}|string} question
 * @param {string} attempt
 * @returns {{verdict:'correct'|'incorrect'|'prompt',method:string}}
 */
export function gradeAnswer(question, attempt) {
  const result = (verdict, method) => ({ verdict, method });
  if (typeof attempt !== 'string' || !attempt.trim() || attempt.length > 500) return result('incorrect', 'empty-or-invalid');
  const attempted = words(attempt);
  if (!attempted.length || attempted.length > 60) return result('incorrect', 'empty-or-invalid');
  const parsed = parseAnswerline(question);
  if (!parsed.accepts.length) return result('prompt', 'unparseable-answerline');
  const exact = item => item.full.join(' ') === attempted.join(' ') || item.full.join('') === attempted.join('');
  for (const item of parsed.rejects) if (exact(item)) return result(item.conditional ? 'prompt' : 'incorrect', item.conditional ? 'conditional-reject' : 'explicit-reject');
  for (const item of parsed.prompts) if (matches(item, attempted) || exact(item)) return result('prompt', 'explicit-prompt');
  for (const item of parsed.accepts) if (exact(item) || matches(item, attempted)) return result(item.conditional ? 'prompt' : 'correct', item.conditional ? 'conditional-accept' : 'answerline-match');
  for (const item of parsed.accepts) if (matches(item, attempted, true)) return result(item.conditional ? 'prompt' : 'correct', item.conditional ? 'conditional-accept' : 'conservative-typo');
  if (parsed.partial && parsed.accepts.some(item => attempted.length < item.full.length && attempted.every(token => item.full.includes(token)))) return result('prompt', 'partial-answer');
  return result('incorrect', 'no-match');
}

export default gradeAnswer;
