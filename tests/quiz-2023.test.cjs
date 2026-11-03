const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {load}=require('./helpers/quiz-harness.cjs');
(async()=>{
 const h=await load('gate-cse-2023'),d=h.data,rows=JSON.parse(fs.readFileSync('tests/fixtures/gate-cse-2023-key.json'));
 assert.equal(d.questions.length,65);assert.equal(h.t.summarize(h.t.grade()).score,1);
 for(const [num,type,sec,key,m] of rows){
  const q=d.questions.find(q=>q.id===`${sec}-${num}`);assert.equal(q.type,type.toLowerCase());assert.equal(q.marks,+m);assert(fs.existsSync('gate-cse-2023/'+q.images[0].src));
  if(key==='MTA'){assert(q.marksToAll);continue;}
  let candidates;
  if(type==='MCQ')candidates=[...'ABCD'].map(a=>[a,a===key]);
  else if(type==='MSQ'){const sets=key.split(' or ').map(s=>s.match(/[ABCD]/g));candidates=Array.from({length:15},(_,i)=>{const a=[...'ABCD'].filter((_,j)=>(i+1)&(1<<j));return[a,sets.some(s=>s.length===a.length&&s.every(x=>a.includes(x)))];});}
  else {const ranges=[...key.matchAll(/([\d.]+) to ([\d.]+)/g)].map(m=>[+m[1],+m[2]]);candidates=ranges.flatMap(([a,b])=>[[String(a),true],[String(b),true],[String(a-.00001),false],[String(b+.00001),false]]);if(num==='30')candidates.push(['3',false]);}
  for(const [answer,correct] of candidates){h.t.answers[q.id]=answer;const r=h.t.grade().find(r=>r.question.id===q.id);assert.equal(r.outcome,correct?'correct':'incorrect',q.id+': '+answer);}
  h.t.answers[q.id]=type==='NAT'?key.match(/[\d.]+/)[0]:type==='MSQ'?key.split(' or ')[0].match(/[ABCD]/g):key;
 }
 assert.equal(h.t.summarize(h.t.grade()).score,100);
 const context={require,module:{exports:{}},__dirname:process.cwd(),console,process};vm.createContext(context);vm.runInContext(fs.readFileSync('server.cjs','utf8')+'\nmodule.exports.scoreAttempt=scoreAttempt;',context);
 const attempt={version:1,quizId:d.id,quizSignature:JSON.stringify({questions:d.questions,scoring:d.scoring}),submittedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),answers:JSON.parse(JSON.stringify(h.t.answers))};
 assert.equal(context.module.exports.scoreAttempt(attempt,d).score,100);attempt.answers['CS-27']=['C','D'];assert.equal(context.module.exports.scoreAttempt(attempt,d).score,100);attempt.answers['CS-27']=['D'];assert.equal(context.module.exports.scoreAttempt(attempt,d).score,99);
 attempt.outOfSyllabus=d.questions.map(q=>q.id);assert.equal(context.module.exports.scoreAttempt(attempt,d).percentage,null);
 console.log('2023: all key entries, MCQ choices, 225 MSQ subsets, NAT boundaries/gap, awards, perfect/blank and server alternative grading passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
