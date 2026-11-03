const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
let source=fs.readFileSync(path.join(__dirname,'quiz-runtime.test.cjs'),'utf8');source=source.slice(0,source.indexOf('\n(async () => {'));
const {load}=new Function('require',source+'\nreturn {load};')(require);
(async()=>{
 const folder=path.resolve(__dirname,'../gate-cse-2022'), h=await load(folder), qs=h.data.questions;
 const keys=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/gate-cse-2022-key.json')));
 assert.equal(qs.length,65);assert.equal(qs.reduce((s,q)=>s+q.marks,0),100);
 assert.deepEqual(['mcq','msq','nat'].map(t=>qs.filter(q=>q.type===t).length),[32,15,18]);
 for(const f of ['styles.css','theme.js','quiz.js','rough-work.js','rough-work-engine.js'])assert.equal(fs.readFileSync(path.join(folder,f),'utf8'),fs.readFileSync(path.join(__dirname,'../_template',f),'utf8'));
 for(const s of h.data.sourceFiles)assert.equal(crypto.createHash('sha256').update(fs.readFileSync('/Users/icode100/Downloads/'+s.filename)).digest('hex'),s.sha256);
 for(let i=0;i<65;i++){
  const q=qs[i],[n,type,section,key,marks]=keys[i];assert.equal(q.id,`${section}-${n}`);assert.equal(q.type,type.toLowerCase());assert.equal(q.marks,+marks);assert.equal(q.incorrectMarks,type==='MCQ'?-marks/3:0);
  for(const im of q.images){const buf=fs.readFileSync(path.join(folder,im.src));assert.equal(buf.toString('hex',0,8),'89504e470d0a1a0a');}
  const test=(answer,expected)=>{h.t.answers[q.id]=answer;assert.equal(h.t.grade()[i].outcome,expected,`${q.id} ${answer}`);delete h.t.answers[q.id];};
  if(type==='MCQ'){assert.equal(q.correctAnswer,key);for(const c of 'ABCD')test(c,c===key?'correct':'incorrect');}
  else if(type==='MSQ'){assert.equal(q.correctAnswers.join(','),key);for(let m=1;m<16;m++){let a=[...'ABCD'].filter((_,j)=>m&(1<<j));test(a,a.join(',')===key?'correct':'incorrect');}}
  else {const [a,b]=key.split(' to ').map(Number);assert.equal(q.correctRanges[0].min,a);assert.equal(q.correctRanges[0].max,b);test(String(a),'correct');test(String(b),'correct');test(String(a-0.000001),'incorrect');test(String(b+0.000001),'incorrect');}
 }
 assert.equal(h.t.summarize(h.t.grade()).score,0);
 for(const q of qs)h.t.answers[q.id]=q.type==='mcq'?q.correctAnswer:q.type==='msq'?[...q.correctAnswers]:String(q.correctRanges[0].min);
 assert.equal(h.t.summarize(h.t.grade()).score,100);
 for(const q of qs)h.t.answers[q.id]=q.type==='mcq'?[...'ABCD'].find(c=>c!==q.correctAnswer):q.type==='msq'?['Z']:String(q.correctRanges[0].max+1);
 assert(Math.abs(h.t.summarize(h.t.grade()).score+47/3)<1e-9);
 assert(!fs.existsSync(path.join(folder,'attempt.json')));console.log('PASS 2022: 65 verified keys, 100 marks, all MCQ choices/MSQ subsets/NAT boundaries, blank/perfect/negative scores, crops, source hashes and template synchronization. Simulated attempts only.');
})().catch(e=>{console.error(e);process.exitCode=1;});
