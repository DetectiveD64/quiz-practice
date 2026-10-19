import { gradeAnswer } from './grading.mjs';

// Compatibility entry point for older callers. Model confidence is not evidence
// that an answer is equivalent: the local model accepted arbitrary letters and
// repeated-letter strings. Only answer-key rules can award points.
export async function gradeWithSemantic(question, attempt) {
  return gradeAnswer(question, attempt);
}

export default gradeWithSemantic;