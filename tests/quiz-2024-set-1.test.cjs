const assert=require('assert'),fs=require('fs'),path=require('path');
const {load}=require('./helpers/quiz-harness.cjs');
const fixture=require('./fixtures/gate-cse-2024-set-1-key.json');
(async()=>{
 const h=await load('gate-cse-2024-set-1');const {t,data}=h;
 assert.equal(data.questions.length,65);assert.equal(t.summarize(t.grade()).maximum,100);assert.equal(t.summarize(t.grade()).score,0);
 for(const q of data.questions){const k=fixture.questions.find(x=>x.id===q.id);for(const prop of Object.keys(k)) assert.deepStrictEqual(JSON.parse(JSON.stringify(q[prop])),k[prop]);assert(fs.existsSync(path.join(__dirname,'../gate-cse-2024-set-1',q.images[0].src)));}
 for(const k of fixture.questions){
  if(k.type==='mcq') for(const a of 'ABCD'){t.answers[k.id]=a;assert.equal(t.grade().find(r=>r.question.id===k.id).outcome,a===k.correctAnswer?'correct':'incorrect');}
  if(k.type==='msq') for(let bits=0;bits<16;bits++){const a=[...'ABCD'].filter((_,i)=>bits&(1<<i));if(a.length)t.answers[k.id]=a;else delete t.answers[k.id];assert.equal(t.grade().find(r=>r.question.id===k.id).outcome,!a.length?'unanswered':a.length===k.correctAnswers.length&&a.every(c=>k.correctAnswers.includes(c))?'correct':'incorrect');}
  if(k.type==='nat') for(const [v,ok] of [[k.correctRanges[0].min,true],[k.correctRanges[0].max,true],[k.correctRanges[0].min-.000001,false],[k.correctRanges[0].max+.000001,false]]){t.answers[k.id]=String(v);assert.equal(t.grade().find(r=>r.question.id===k.id).outcome,ok?'correct':'incorrect');}
 }
 fixture.questions.forEach(k=>t.answers[k.id]=k.type==='nat'?String(k.correctRanges[0].min):k.type==='msq'?k.correctAnswers:k.correctAnswer);
 assert.equal(t.summarize(t.grade()).score,100);
 for(const f of ['quiz.js','styles.css','theme.js','rough-work.js','rough-work-engine.js']) assert.equal(fs.readFileSync(path.join(__dirname,'../gate-cse-2024-set-1',f),'utf8'),fs.readFileSync(path.join(__dirname,'../_template',f),'utf8'));
 let expected=0;fixture.questions.forEach((k,i)=>{if(i%3===0){delete t.answers[k.id];}else if(i%3===1){expected+=k.marks;}else{t.answers[k.id]=k.type==='nat'?String(k.correctRanges[0].max+1):k.type==='msq'?['A','B','C','D']:[...'ABCD'].find(a=>a!==k.correctAnswer);expected+=k.incorrectMarks;}});assert(Math.abs(t.summarize(t.grade()).score-expected)<1e-9);
 assert(!fs.existsSync(path.join(__dirname,'../gate-cse-2024-set-1/attempt.json')));console.log('2024 Set 1: key, 65 assets, all MCQ choices/MSQ subsets/NAT boundaries, blank/perfect scores and shared runtime passed');
})().catch(e=>{console.error(e);process.exitCode=1});
