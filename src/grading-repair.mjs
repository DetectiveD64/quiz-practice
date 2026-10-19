import { gradeAnswer } from './grading.mjs';

// Repair only demonstrable random-letter false positives from the retired model
// override. Real synonyms from older sessions are left for individual review.
export function repairLegacySemanticAttempts(state, questions) {
  const corrected = [];
  const attempts = state.attempts.map(record => {
    if (record.verdict !== 'correct' || record.method !== 'local-semantic-equivalent'
      || typeof record.attempt !== 'string' || !/^([a-z])\1*$/i.test(record.attempt.trim())) return record;
    const question = questions.get(record.questionId);
    if (!question?.answerline) return record;
    const result = gradeAnswer({ ...question, answer: question.answerline }, record.attempt);
    if (result.verdict !== 'incorrect') return record;
    corrected.push(record.id);
    return { ...record, verdict: 'incorrect', method: 'answerline-recheck',
      originalVerdict: record.verdict, originalMethod: record.method,
      gradingCorrection: 'Removed an unsupported random-letter AI acceptance.' };
  });
  return { state: corrected.length ? { ...state, attempts } : state, corrected };
}
