import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeWithSemantic } from '../src/semantic.mjs';

test('random letters and repeated-letter guesses cannot be promoted by a model', async () => {
  let calls=0;
  const options={fetchImpl:async()=>{calls++;return new Response(JSON.stringify({done:true,message:{content:JSON.stringify({equivalent:true,relation:'same_entity',confidence:'high'})}}));}};
  for(const answer of ['<u>Alcatraz</u> Island','<u>Mississippi</u> River','<u>Alaska</u>','<u>Sikh</u>ism','<u>Brazil</u>','<u>Antarctica</u>','<u>Kabbalah</u>','<u>Madagascar</u>']) {
    for(const attempt of ['w','q','e','r','s','a','wwwwwwwww','vvvvvvvvvvvvvvvvvvvvvvvv','completely unrelated answer']) {
      assert.equal((await gradeWithSemantic({answer},attempt,options)).verdict,'incorrect',`${answer} / ${attempt}`);
    }
  }
  assert.equal(calls,0);
});

test('answer-key aliases, required names, spelling tolerance and prompt instructions still work',async()=>{
  for(const [answer,attempt,verdict] of [
    ['<u>sulfur</u> [or S]','s','correct'],
    ['<u>enthalpy</u> [or H before mention]','H','prompt'],
    ['<u>tungsten</u> [accept W]','W','correct'],
    ['<u>Samuel Clemens</u> [accept Mark Twain]','Mark Twain','correct'],
    ['William <u>Shakespeare</u>','Shakespear','correct'],
    ['<u>communion</u>','commuion','correct'],
    ['<u>John Adams</u> [prompt on Adams]','Adams','prompt'],
    ['sodium chloride','NaCl','correct'],
    ['<u>proton</u> [reject photon]','photon','incorrect'],
    ['Arthur <u>Miller</u>','Henry Miller','incorrect'],
    ['World War II','World War I','incorrect'],
    ['photosynthesis','cellular respiration','incorrect'],
  ]) assert.equal((await gradeWithSemantic({answer},attempt)).verdict,verdict,`${answer} / ${attempt}`);
});