const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { load, editResponse, draftKey, attemptUrl, rejectFileDialogs } = require('./helpers/quiz-harness.cjs');
const folder = path.resolve(__dirname, '../gate-cse-2009');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gate-cse-2009-key.json'), 'utf8'));
for (const row of fixture.questions) row.answers = row.acceptedAnswers || [row.correctAnswer];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (a,b) => assert.deepEqual(JSON.parse(JSON.stringify(a)),b);
const close = (a,b) => assert(Math.abs(a-b)<1e-9, `${a} != ${b}`);
const card = (h,n) => h.document.getElementById(`question-card-${n-1}`);
const nav = (h,n) => h.document.getElementById(`nav-question-${n-1}`);
const flag = (h,n) => h.document.getElementById(`mark-review-${n-1}`);
const text = node => [node.textContent, ...node.children.map(text)].join(' ');
const reset = h => Object.keys(h.t.answers).forEach(id => delete h.t.answers[id]);

async function checkHome(data) {
  const fsp=fs.promises, os=require('node:os'), http=require('node:http');
  const {createServer}=require('../server.cjs');
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'quiz-2009-test-'));
  const quiz=path.join(temp,'gate-cse-2009'),server=createServer({root:temp,port:0});
  try {
    await fsp.mkdir(quiz);
    for(const name of ['index.html','quiz-data.js']) await fsp.copyFile(path.join(folder,name),path.join(quiz,name));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port,origin=`http://127.0.0.1:${port}`;
    const request=(url,record)=>new Promise((resolve,reject)=>{
      const body=record && JSON.stringify(record);
      const req=http.request({hostname:'127.0.0.1',port,path:url,method:record?'POST':'GET',
        headers:record?{'Content-Type':'application/json',Origin:origin}:{}},res=>{
          let out='';res.setEncoding('utf8');res.on('data',x=>out+=x);res.on('end',()=>resolve({status:res.statusCode,body:out}));
        });
      req.on('error',reject);req.end(body);
    });
    const readCard=async()=>{
      const home=await request('/');assert.equal(home.status,200);
      return (home.body.match(/<li\b[\s\S]*?<\/li>/g)||[]).find(x=>x.includes('href="/gate-cse-2009/"'));
    };
    assert.match(await readCard(),/data-attempted="false"/);
    assert.equal((await request('/gate-cse-2009/attempt.json')).status,404);
    const answers=Object.fromEntries(fixture.questions.map(row=>[`CS-${row.number}`,row.answers[0]]));
    answers['CS-37']='C';answers['CS-44']='B';answers['CS-55']='D';
    const attempt={version:1,quizId:data.id,quizSignature:JSON.stringify({questions:data.questions,scoring:data.scoring}),
      submittedAt:'2026-10-15T00:00:00.000Z',updatedAt:'2026-10-15T00:00:00.000Z',answers,summary:{score:999},results:[]};
    assert.equal((await request('/gate-cse-2009/attempt.json',attempt)).status,200);
    assert.match(await readCard(),/Last score: 100 \/ 100/);
    answers['CS-57']='A'; answers['CS-59']=null;
    assert.equal((await request('/gate-cse-2009/attempt.json',attempt)).status,200);
    assert.match(await readCard(),/Last score: 91\.3333 \/ 100/,'Actual paper gates both second answers');
    answers['CS-57']='D';answers['CS-59']='C';answers['CS-58']='A';answers['CS-60']='A';
    assert.equal((await request('/gate-cse-2009/attempt.json',attempt)).status,200);
    assert.match(await readCard(),/Last score: 96 \/ 100/,'Second wrong answers have no penalty');
    attempt.answers=Object.fromEntries(fixture.questions.map(row=>[`CS-${row.number}`,[...'ABCD'].find(x=>!row.answers.includes(x))]));
    assert.equal((await request('/gate-cse-2009/attempt.json',attempt)).status,200);
    const negative=await readCard(); assert.match(negative,/Last score: -32 \/ 100/);assert.match(negative,/<progress class="paper-score-bar" value="0" max="100"/);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));
    assert(path.basename(temp).startsWith('quiz-2009-test-'));
    await fsp.rm(temp,{recursive:true,force:true});
  }
}

(async () => {
  const h = await load(folder), {data,t,ids} = h;
  const noDialogs = rejectFileDialogs(h);
  assert.equal(data.id,'gate-cse-2009'); assert.equal(data.questions.length,60); t.validate();
  assert.equal(fixture.questions.length,60);
  const imageNames = new Set();
  for (const q of data.questions) {
    const expected = fixture.questions[q.number-1];
    assert.equal(q.id,`CS-${q.number}`); assert.equal(q.type,'mcq'); assert.equal(q.section,'CS');
    assert.equal(q.number,expected.number); assert.equal(q.marks,q.number<=20?1:2);
    close(q.incorrectMarks,[58,60].includes(q.number)?0:-q.marks/3);
    same(q.acceptedAnswers || [q.correctAnswer],expected.answers);
    same(q.options.map(o=>o.id),['A','B','C','D']);
    assert.equal(q.requiresCorrect, q.number===58?'CS-57':q.number===60?'CS-59':undefined);
    assert(q.images.length && q.sourceRectangles.length===q.images.length);
    same(q.sourcePages,[...new Set(q.images.map(i=>i.page))]);
    for(let i=0;i<q.images.length;i++) {
      const im=q.images[i],rect=q.sourceRectangles[i];
      assert(!path.isAbsolute(im.src) && im.src.startsWith('assets/'));
      const bytes=fs.readFileSync(path.join(folder,im.src)); imageNames.add(im.src);
      assert.equal(bytes.subarray(1,4).toString(),'PNG');
      assert(bytes.readUInt32BE(16)>100 && bytes.readUInt32BE(20)>30);
      assert.equal(im.page,rect.page); assert(rect.rect[0]<rect.rect[2] && rect.rect[1]<rect.rect[3]);
      assert(im.alt.includes(String(q.number)) && im.alt.includes(String(im.page)));
    }
  }
  for(const [filename,hash] of Object.entries(fixture.sourceSha256)) assert.equal(sha(path.join(folder,filename)),hash,filename);
  for(const name of ['quiz.js','styles.css','theme.js']) assert.equal(sha(path.join(folder,name)),sha(path.resolve(__dirname,'../_template',name)));
  assert(!fs.existsSync(path.join(folder,'attempt.json')), 'Development must not create a real attempt');
  close(t.summarize(t.grade()).maximum,100); close(t.summarize(t.grade()).score,0);
  for(const row of fixture.questions) t.answers[`CS-${row.number}`]=row.answers[0];
  close(t.summarize(t.grade()).score,100); assert.equal(t.summarize(t.grade()).counts.correct,60);
  reset(h);
  let optionChecks=0;
  for(const row of fixture.questions) for(const option of 'ABCD') {
    reset(h); const q=data.questions[row.number-1];
    if(q.requiresCorrect) t.answers[q.requiresCorrect]=fixture.questions[Number(q.requiresCorrect.slice(3))-1].answers[0];
    t.answers[q.id]=option;
    const actual=t.grade()[row.number-1],correct=row.answers.includes(option);
    assert.equal(actual.outcome,correct?'correct':'incorrect'); close(actual.earned,correct?q.marks:q.incorrectMarks); optionChecks++;
  }
  reset(h);
  for(const row of fixture.questions) t.answers[`CS-${row.number}`]=[...'ABCD'].find(x=>!row.answers.includes(x));
  close(t.summarize(t.grade()).score,-32); assert.equal(t.summarize(t.grade()).counts.blocked,2);
  reset(h); t.answers['CS-1']='A'; t.answers['CS-2']='B'; t.answers['CS-57']='D'; t.answers['CS-58']='C'; t.answers['CS-60']='D';
  close(t.summarize(t.grade()).score,1-1/3+4); assert.equal(t.grade()[59].outcome,'blocked');

  // Response/flag draft lifecycle and saved report always use in-memory fetch/storage.
  reset(h); t.renderQuestions();
  assert.equal(ids['questions'].querySelectorAll('input').length,240);
  assert.equal(ids['nav-groups'].querySelectorAll('.nav-question').length,60);
  assert.equal(ids['questions'].querySelectorAll('img').length,data.questions.reduce((n,q)=>n+q.images.length,0));
  await editResponse(h,'CS-1','A'); await flag(h,1).click();
  assert.equal(ids['nav-progress'].textContent,'1 attempted · 59 not attempted');
  assert.equal(flag(h,1).attrs['aria-pressed'],'true'); assert(ids['review-attempt'].disabled);
  const restored=await load(folder,{storage:h.storage,server:h.server});
  assert.equal(restored.t.answers['CS-1'],'A'); assert.equal(flag(restored,1).attrs['aria-pressed'],'true');
  assert(card(restored,1).querySelectorAll('input').find(i=>i.value==='A').checked);
  await card(restored,1).querySelector('.clear-response').click();
  assert.equal(restored.t.answers['CS-1'],undefined); assert.equal(flag(restored,1).attrs['aria-pressed'],'true');
  await editResponse(restored,'CS-11','A'); await editResponse(restored,'CS-58','C');
  await restored.ids['quiz-form'].fire('submit');
  const submission=restored.server.get(attemptUrl(restored));
  assert.equal(submission.results.length,60); assert.equal(Object.keys(submission.answers).length,60);
  assert(!restored.storage.has(draftKey(restored))); assert(!Object.hasOwn(submission,'reviewFlags'));
  close(submission.summary.score,1); assert.equal(submission.results[57].outcome,'blocked');
  const reportText=text(restored.ids['report-list']);
  assert(reportText.includes('Not evaluated') && reportText.includes('Correct answer:') && reportText.includes('Your answer:'));
  assert.equal(restored.ids['report-list'].querySelectorAll('.result-card').length,60);
  await nav(restored,58).click(); assert(restored.document.getElementById('result-card-57').focused);
  const saved=JSON.stringify(submission);
  await restored.ids['retry-quiz'].click(); assert.equal(Object.keys(restored.t.answers).length,0);
  assert.equal(JSON.stringify(restored.server.get(attemptUrl(restored))),saved);
  assert.equal(flag(restored,1).attrs['aria-pressed'],'false');
  await editResponse(restored,'CS-2','D'); await flag(restored,2).click();
  const draft=restored.storage.get(draftKey(restored));
  submission.summary.score=999; submission.results=[];
  await restored.ids['review-attempt'].click(); close(restored.t.summarize(restored.t.grade()).score,1);
  assert.equal(restored.storage.get(draftKey(restored)),draft);
  await restored.ids['retry-quiz'].click(); assert.equal(restored.t.answers['CS-2'],'D'); assert.equal(flag(restored,2).attrs['aria-pressed'],'true');
  await restored.ids['clear-answers'].click(); assert.equal(flag(restored,2).attrs['aria-pressed'],'false');
  const failed=await load(folder,{fetch:(r,perform,response)=>r.method==='POST'?response(500,{error:'Fixture failure'}):perform()});
  await editResponse(failed,'CS-1','A'); await flag(failed,1).click(); await failed.ids['quiz-form'].fire('submit');
  assert(failed.storage.has(draftKey(failed))); assert(!failed.ids.report.hidden); assert.equal(flag(failed,1).attrs['aria-pressed'],'true');
  const unavailable=await load(folder,{storageUnavailable:true});
  await editResponse(unavailable,'CS-1','A'); await unavailable.ids['quiz-form'].fire('submit');
  await unavailable.ids['retry-quiz'].click(); assert.equal(Object.keys(unavailable.t.answers).length,0);
  assert.match(unavailable.ids['status-message'].textContent,/Could not cache/);
  vm.runInContext(fs.readFileSync(path.join(folder,'theme.js'),'utf8'),restored.ctx); restored.document.DOMContentLoaded();
  const beforeTheme=restored.storage.get(draftKey(restored)); await restored.ids['theme-toggle'].click();
  assert.equal(restored.storage.get('practice-quiz:theme'),'dark'); assert.equal(restored.storage.get(draftKey(restored)),beforeTheme);
  noDialogs();
  await checkHome(data);
  console.log(`PASS: GATE 2009 independent 60-entry key, ${optionChecks} MCQ choices, source hashes, ${imageNames.size} original PNG crops, 100-mark blank/perfect/mixed/negative scores, linked gating, map/report images, draft reload/clear/flags, Submit/retry/review, failed save/storage, theme isolation, actual-paper temporary-server alternate keys/linked gates/no second penalty/negative score. No real attempt written.`);
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
