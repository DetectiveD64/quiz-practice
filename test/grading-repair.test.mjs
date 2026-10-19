import test from 'node:test';
import assert from 'node:assert/strict';
import { repairLegacySemanticAttempts } from '../src/grading-repair.mjs';

test('repair corrects only proven random-letter model awards and preserves the original record',()=>{
  const records=[
    {id:'bad',questionId:'island',attempt:'w',verdict:'correct',method:'local-semantic-equivalent'},
    {id:'repeated',questionId:'island',attempt:'wwwww',verdict:'correct',method:'local-semantic-equivalent'},
    {id:'valid-letter',questionId:'element',attempt:'S',verdict:'correct',method:'local-semantic-equivalent'},
    {id:'conditional',questionId:'enthalpy',attempt:'H',verdict:'correct',method:'local-semantic-equivalent'},
    {id:'valid-words',questionId:'island',attempt:'Alcatraz',verdict:'correct',method:'local-semantic-equivalent'},
    {id:'other-rule',questionId:'island',attempt:'w',verdict:'correct',method:'answerline-match'},
    {id:'uncached',questionId:'unknown',attempt:'w',verdict:'correct',method:'local-semantic-equivalent'},
  ];
  const state={attempts:records,seen:['island'],preferences:{readAloud:true}};
  const questions=new Map([['island',{answerline:'<u>Alcatraz</u> Island'}],['element',{answerline:'<u>sulfur</u> [or S]'}],['enthalpy',{answerline:'<u>enthalpy</u> [or H before mention]'}]]);
  const result=repairLegacySemanticAttempts(state,questions);
  assert.deepEqual(result.corrected,['bad','repeated']);
  assert.deepEqual(state.attempts,records);
  assert.equal(records[0].verdict,'correct');
  assert.equal(result.state.attempts[0].verdict,'incorrect');
  assert.equal(result.state.attempts[0].originalVerdict,'correct');
  assert.equal(result.state.attempts[0].originalMethod,'local-semantic-equivalent');
  assert.deepEqual(result.state.attempts.slice(2),records.slice(2));
  assert.deepEqual(result.state.seen,state.seen);
  assert.deepEqual(result.state.preferences,state.preferences);
  assert.deepEqual(repairLegacySemanticAttempts(result.state,questions).corrected,[]);
});
