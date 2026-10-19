import { setTimeout as sleep } from 'node:timers/promises';

// Small, on-demand batches from QBReader's documented public API. Questions
// retain their writers' copyright and are used for noncommercial practice.
// https://github.com/qbreader and https://www.qbreader.org/tools/api-docs/
const ORIGIN = 'https://www.qbreader.org';
const API = `${ORIGIN}/api`;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const requestQueues = new WeakMap();
const catalogCaches = new WeakMap();

export const TOPICS = Object.freeze([
  'Science', 'History', 'Literature', 'Fine Arts', 'Geography',
  'Religion', 'Mythology', 'Philosophy', 'Social Science', 'Other',
]);
// Exact labels verified in QBReader's DifficultyDropdown.jsx. Grouping into
// these four filters is this app's presentation, not a change to the scale.
export const LEVELS = Object.freeze([
  { id: 'middle', label: 'Middle School', difficulties: Object.freeze([1]) },
  { id: 'high', label: 'High School', difficulties: Object.freeze([2, 3, 4, 5]) },
  { id: 'college', label: 'College', difficulties: Object.freeze([6, 7, 8, 9]) },
  { id: 'open', label: 'Open', difficulties: Object.freeze([10]) },
].map(Object.freeze));
export const DIFFICULTY_LABELS = Object.freeze({
  1: 'Middle School', 2: 'Easy High School', 3: 'Regular High School',
  4: 'Hard High School', 5: 'National High School', 6: 'Easy College',
  7: 'Medium College', 8: 'Regionals College', 9: 'Nationals College', 10: 'Open',
});
const TOPIC_CATEGORIES = Object.freeze(Object.fromEntries(TOPICS.map(topic => [
  topic, topic === 'Other' ? ['Other Academic', 'Current Events'] : [topic],
])));

export class SourceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'SourceError';
    this.code = code;
  }
}

const ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ensp: ' ', emsp: ' ', thinsp: ' ', hairsp: ' ', newline: ' ', Tab: ' ',
  ndash: '–', mdash: '—', minus: '−', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×',
  divide: '÷', micro: 'µ', frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³', prime: '′', Prime: '″',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', equiv: '≡', infin: '∞',
  radic: '√', sum: '∑', prod: '∏', int: '∫', part: '∂', nabla: '∇',
  rarr: '→', larr: '←', harr: '↔', rArr: '⇒', hArr: '⇔',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ',
  mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  aacute: 'á', Aacute: 'Á', eacute: 'é', Eacute: 'É', iacute: 'í', Iacute: 'Í',
  oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú', yacute: 'ý',
  agrave: 'à', Agrave: 'À', egrave: 'è', Egrave: 'È', igrave: 'ì',
  ograve: 'ò', ugrave: 'ù', acirc: 'â', Acirc: 'Â', ecirc: 'ê',
  icirc: 'î', ocirc: 'ô', Ocirc: 'Ô', ucirc: 'û', atilde: 'ã',
  ntilde: 'ñ', Ntilde: 'Ñ', otilde: 'õ', auml: 'ä', Auml: 'Ä',
  euml: 'ë', iuml: 'ï', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü',
  aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ', oelig: 'œ', OElig: 'Œ',
  ccedil: 'ç', Ccedil: 'Ç', szlig: 'ß', oslash: 'ø', Oslash: 'Ø',
  eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ', fnof: 'ƒ', shy: '',
});

export function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, entity) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : '�';
    }
    return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity] : whole;
  });
}

function scrubMarkup(value) {
  if (typeof value !== 'string') return '';
  let result = value;
  // Two passes also handle a common double-encoded entity without repeatedly
  // expanding arbitrary nested encodings or executing any source content.
  for (let i = 0; i < 2; i++) result = decodeEntities(result);
  return result
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|iframe|object|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup\s*>/gi, '^($1)')
    .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub\s*>/gi, '_($1)')
    .replace(/<\/?(?:p|div|br|li|tr|h[1-6])\b[^>]*>/gi, ' ');
}

function normalizeWhitespace(value) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Output is inert text, never HTML. Consumers must render it with textContent.
export function cleanText(value) {
  return normalizeWhitespace(scrubMarkup(value)
    .replace(/<\/?[a-z][^>]*>/gi, '')
  );
}

// Kept in backend storage for deterministic grading: underlines mark required
// answer words. This is parser data, never renderer HTML or executable code.
export function cleanAnswerline(value) {
  return normalizeWhitespace(scrubMarkup(value).replace(/<(\/?)([a-z][\w:-]*)\b[^>]*>/gi,
    (_, closing, tag) => ['b', 'strong', 'u', 'i', 'em'].includes(tag.toLowerCase())
      ? `<${closing}${tag.toLowerCase()}>` : ''));
}

export function levelForDifficulty(difficulty) {
  if (!Number.isInteger(difficulty)) return null;
  return LEVELS.find(level => level.difficulties.includes(difficulty))?.id ?? null;
}

function selectedFilters(topics, levels) {
  const selectedTopics = topics === undefined ? [...TOPICS] : topics;
  const selectedLevels = levels === undefined ? LEVELS.map(level => level.id) : levels;
  if (!Array.isArray(selectedTopics) || !Array.isArray(selectedLevels)
      || selectedTopics.some(topic => !TOPICS.includes(topic))
      || selectedLevels.some(id => !LEVELS.some(level => level.id === id))) {
    throw new SourceError('INVALID_FILTER', 'Choose topics and levels from the available practice filters.');
  }
  return {
    topics: [...new Set(selectedTopics)], levels: [...new Set(selectedLevels)],
    categories: [...new Set(selectedTopics.flatMap(topic => TOPIC_CATEGORIES[topic]))],
    difficulties: LEVELS.filter(level => selectedLevels.includes(level.id)).flatMap(level => level.difficulties),
  };
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date());
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid current time.');
  return date.toISOString();
}

function safeId(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,100}$/i.test(value) ? value : null;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function queuedRequest(fetchImpl, run, sleepImpl) {
  const queue = requestQueues.get(fetchImpl) ?? { tail: Promise.resolve(), lastStart: 0 };
  requestQueues.set(fetchImpl, queue);
  const result = queue.tail.catch(() => {}).then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - queue.lastStart));
    if (wait) await sleepImpl(wait);
    queue.lastStart = Date.now();
    return run();
  });
  queue.tail = result.catch(() => {});
  return result;
}

async function readJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > MAX_RESPONSE_BYTES) throw new SourceError('INVALID_RESPONSE', 'The archive response was too large.');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new SourceError('INVALID_RESPONSE', 'The archive response was too large.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new SourceError('INVALID_RESPONSE', 'The archive response was too large.');
  }
  try { return JSON.parse(text); }
  catch { throw new SourceError('INVALID_RESPONSE', 'The archive returned an unreadable response. Please try again later.'); }
}

async function requestJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000, sleepImpl = sleep } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN || !['/api/set-list', '/api/random-tossup'].includes(parsed.pathname)) {
    throw new SourceError('INVALID_SOURCE', 'This request is not an approved archive endpoint.');
  }
  const limit = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(15000, timeoutMs)) : 15000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await queuedRequest(fetchImpl, async () => {
        const controller = new AbortController();
        let timer;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new SourceError('TIMEOUT', 'The question archive took too long to respond. Please try again.'));
          }, limit);
        });
        try {
          return await Promise.race([deadline, (async () => {
            const response = await fetchImpl(url, {
              signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' },
            });
            if (response.url && new URL(response.url).origin !== ORIGIN) {
              throw new SourceError('INVALID_SOURCE', 'The archive response came from an unexpected location.');
            }
            if (!response.ok) {
              const error = new SourceError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
                response.status === 429 ? 'The archive is busy. Please try again shortly.'
                  : 'The question archive is temporarily unavailable. Please try again later.');
              error.retryable = [429, 500, 502, 503, 504].includes(response.status);
              const retryAfter = response.headers?.get?.('retry-after');
              const retrySeconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : null;
              const retryDate = retrySeconds === null && retryAfter ? Date.parse(retryAfter) : NaN;
              error.retryDelay = retrySeconds !== null ? Math.max(1000, retrySeconds * 1000)
                : Number.isFinite(retryDate) ? Math.max(1000, retryDate - Date.now()) : 1000;
              throw error;
            }
            return await readJson(response);
          })()]);
        } finally { clearTimeout(timer); }
      }, sleepImpl);
    } catch (cause) {
      const error = cause instanceof SourceError ? cause
        : new SourceError('NETWORK_ERROR', 'Could not reach the question archive. Check your connection and try again.', { cause });
      const retryable = error.retryable || ['NETWORK_ERROR', 'TIMEOUT'].includes(error.code);
      if (attempt === 0 && retryable && (error.retryDelay ?? 1000) <= 5000) {
        await sleepImpl(error.retryDelay ?? 1000);
        continue;
      }
      throw error;
    }
  }
}

export async function getCatalog(options = {}) {
  const { fetchImpl = globalThis.fetch, now, force = false } = options;
  const cached = catalogCaches.get(fetchImpl);
  if (!force && cached?.value && Date.now() - cached.createdAt < CATALOG_TTL_MS) {
    return structuredClone(cached.value);
  }
  if (cached?.pending) return structuredClone(await cached.pending);
  const sourceUrl = `${API}/set-list?expand=true&includeCounts=true`;
  const pending = (async () => {
    const raw = await requestJson(sourceUrl, { ...options, fetchImpl });
    if (!raw || !Array.isArray(raw.setList)) throw new SourceError('INVALID_RESPONSE', 'The archive catalog was not in the expected format.');
    const sets = raw.setList.map(set => {
      const counts = ['packetsCount', 'tossupsCount', 'bonusesCount'].map(key => nonnegativeInteger(set?.[key]));
      const setName = cleanText(set?.setName);
      if (!setName || setName.length > 600 || !safeId(set?._id) || counts.includes(null)
          || !Number.isInteger(set.difficulty) || set.difficulty < 0 || set.difficulty > 10
          || !Number.isInteger(set.year) || set.year < 1900 || set.year > 2200
          || typeof set.standard !== 'boolean') {
        throw new SourceError('INVALID_RESPONSE', 'The archive catalog contains incomplete metadata. Please try again later.');
      }
      return { id: set._id, setName, year: set.year, difficulty: set.difficulty,
        standard: set.standard, packetsCount: counts[0], tossupsCount: counts[1], bonusesCount: counts[2] };
    });
    const totals = sets.reduce((total, set) => ({
      sets: total.sets + 1, packets: total.packets + set.packetsCount,
      tossups: total.tossups + set.tossupsCount, bonuses: total.bonuses + set.bonusesCount,
    }), { sets: 0, packets: 0, tossups: 0, bonuses: 0 });
    const value = { provider: 'QBReader', sets, totals, fetchedAt: timestamp(now), sourceUrl };
    catalogCaches.set(fetchImpl, { value, createdAt: Date.now() });
    return value;
  })();
  catalogCaches.set(fetchImpl, { ...cached, pending });
  try { return structuredClone(await pending); }
  finally {
    const current = catalogCaches.get(fetchImpl);
    if (current?.pending === pending) catalogCaches.set(fetchImpl, { ...current, pending: undefined });
  }
}

export async function randomQuestions(options = {}) {
  const { topics, levels, count = 10, now } = options;
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new SourceError('INVALID_COUNT', 'Request between 1 and 20 practice questions at a time.');
  }
  const filters = selectedFilters(topics, levels);
  const fetchedAt = timestamp(now);
  const url = new URL(`${API}/random-tossup`);
  url.searchParams.set('number', String(count));
  url.searchParams.set('categories', filters.categories.join(','));
  url.searchParams.set('difficulties', filters.difficulties.join(','));
  url.searchParams.set('standardOnly', 'true');
  const result = { questions: [], fetchedAt, sourceUrl: url.href, requestedCount: count, noMatches: true };
  // An explicitly empty selection must not silently expand to every category.
  if (!filters.topics.length || !filters.levels.length) return result;
  const raw = await requestJson(url.href, options);
  if (!raw || !Array.isArray(raw.tossups)) throw new SourceError('INVALID_RESPONSE', 'The archive questions were not in the expected format.');
  const seen = new Set();
  for (const item of raw.tossups.slice(0, 100)) {
    const id = safeId(item?._id);
    const level = levelForDifficulty(item?.difficulty);
    const category = cleanText(item?.category);
    const topic = ['Other Academic', 'Current Events'].includes(category) ? 'Other' : category;
    const text = cleanText(item?.question_sanitized || item?.question);
    const answerline = cleanAnswerline(item?.answer || item?.answer_sanitized);
    const answerText = cleanText(item?.answer_sanitized || item?.answer);
    const setName = cleanText(item?.set?.name);
    if (!id || !level || !text || !answerline || !answerText || !setName || seen.has(id)
        || text.length > 30000 || answerline.length > 15000 || setName.length > 600
        || !filters.topics.includes(topic) || !filters.levels.includes(level)
        || item?.set?.standard === false) continue;
    const packetNumber = nonnegativeInteger(item?.packet?.number);
    const questionNumber = nonnegativeInteger(item?.number);
    if (packetNumber === null || questionNumber === null) continue;
    seen.add(id);
    result.questions.push({
      id, text, answerline, answerText, topic, subcategory: cleanText(item.subcategory),
      level, difficulty: item.difficulty, difficultyLabel: DIFFICULTY_LABELS[item.difficulty],
      source: { provider: 'QBReader', setName, packetNumber, questionNumber,
        packetName: cleanText(item.packet?.name), url: `${ORIGIN}/db/` }, fetchedAt,
    });
    if (result.questions.length === count) break;
  }
  if (raw.tossups.length && !result.questions.length) {
    throw new SourceError('INVALID_RESPONSE', 'The archive returned no usable questions for these filters. Try another selection.');
  }
  result.noMatches = result.questions.length === 0;
  return result;
}
