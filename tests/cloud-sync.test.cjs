'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const fail = (status, message, data) => Object.assign(new Error(message), {status, data});
const deferred = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise, resolve, reject};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const DRAFT = 'practice-quiz:paper', ROUGH = DRAFT + ':rough:CS-1', ANNOTATION = DRAFT + ':annotation:CS-1', ATTEMPT = DRAFT + ':attempt';

class Server {
  constructor() {this.accounts = new Map(); this.offline = false; this.calls = []; this.beforePut = null; this.afterPut = null; this.rejectWrite = null; this.pageSize = 2; this.normalize = null; this.validate = null; this.beforeGet = null;}
  account(uid) {if (!this.accounts.has(uid)) this.accounts.set(uid, {cursor:0, records:new Map()}); return this.accounts.get(uid);}
  record(uid, key) {return clone(this.account(uid).records.get(key) || {key, value:null, revision:0, deleted:true});}
  commit(uid, key, value) {const account=this.account(uid), record={key, value, revision:++account.cursor, deleted:value===null, updatedAt:Date.now()}; account.records.set(key,record); return clone(record);}
  async request(uid, address, options={}) {
    this.calls.push({uid, address, method:options.method || 'GET', body:clone(options.body)});
    if (this.offline) throw new TypeError('Network unavailable');
    const url = new URL(address, 'https://quiz.example');
    if (address.startsWith('/api/reset-attempts')) {for (const record of [...this.account(uid).records.values()]) if (record.key.endsWith(':attempt') && !record.deleted) this.commit(uid,record.key,null);return {saved:true};}
    if ((options.method || 'GET') === 'GET') {
      if (url.searchParams.has('key')) {const key=url.searchParams.get('key');if(this.beforeGet)await this.beforeGet(uid,key);return this.record(uid,key);}
      assert.equal(url.searchParams.has('since'),true,'Manifest calls use the backend since cursor contract');
      const since=Number(url.searchParams.get('since')), all=[...this.account(uid).records.values()].filter(record=>record.revision>since).sort((a,b)=>a.revision-b.revision), selected=all.slice(0,this.pageSize);
      return {records:selected.map(({value,...metadata})=>clone(metadata)), cursor:selected.at(-1)?.revision??since, hasMore:all.length>selected.length};
    }
    if (options.method === 'POST' && options.body?.validateOnly) {if(this.validate)await this.validate(options.body);return {key:options.body.key,value:this.normalize?this.normalize(options.body.key,options.body.value):options.body.value};}
    assert.equal(options.method,'PUT');
    if (this.rejectWrite) throw this.rejectWrite;
    const body=options.body;
    if (this.beforePut) await this.beforePut(uid,clone(body));
    const current=this.record(uid,body.key);
    if (current.revision !== body.baseRevision) throw fail(409,'Changed on another device',{record:current});
    const record=this.commit(uid,body.key,this.normalize ? this.normalize(body.key,body.value) : body.value);
    if (this.afterPut) await this.afterPut(uid,clone(body),clone(record));
    return record;
  }
}
function memoryCache() {const values=new Map();return {values,async read(uid){return clone(values.get(uid));},async write(uid,value){values.set(uid,clone(value));}};}
function fakeIndexedDB() {
  const stores=new Map();let failNext=false;
  const db={createObjectStore(name){stores.set(name,new Map());},transaction(name){const transaction={objectStore(){return {get(key){const request={};queueMicrotask(()=>{request.result=clone(stores.get(name).get(key));transaction.oncomplete?.();});return request;},put(value,key){const request={};queueMicrotask(()=>{if(failNext){failNext=false;transaction.error=Error('Quota exceeded');transaction.onabort?.();return;}stores.get(name).set(key,clone(value));request.result=key;transaction.oncomplete?.();});return request;}};}};return transaction;}};
  return {open(){const request={result:db};queueMicrotask(()=>{if(!stores.size)request.onupgradeneeded?.();request.onsuccess?.();});return request;},fail(){failNext=true;}};
}

(async()=>{
  const root=path.resolve(__dirname,'..'), load=async relative=>import('data:text/javascript;base64,'+Buffer.from(await fs.readFile(path.join(root,relative),'utf8')).toString('base64'));
  const {createCloudSync}=await load('cloud/client/sync.js'), {createAccountCache}=await load('cloud/client/cache.js');
  const devices=[];
  const device=(uid,server,cache=memoryCache(),options={})=>{const events=[], changes=[];const api=createCloudSync({uid,request:(...args)=>server.request(uid,...args),cache,delay:60_000,notify:event=>events.push(clone(event)),remote:event=>changes.push(clone(event)),...options});devices.push(api);return {api,events,changes,cache};};
  try {
    // Native IndexedDB wrapper commits writes and keeps account keys separate.
    const indexed=fakeIndexedDB(), cache=createAccountCache(indexed);
    await cache.write('alice',{uid:'alice',pending:[['raw',' - ']]});await cache.write('bob',{uid:'bob',pending:[]});
    assert.deepEqual(await cache.read('alice'),{uid:'alice',pending:[['raw',' - ']]});assert.equal((await cache.read('bob')).uid,'bob');
    indexed.fail();await assert.rejects(cache.write('alice',{uid:'alice',pending:[]}),/Quota/);assert.equal((await cache.read('alice')).pending.length,1);
    await assert.rejects(createAccountCache(null).read('alice'),/unavailable/);

    const server=new Server(), first=device('alice',server), second=device('alice',server);
    await Promise.all([first.api.ready(),second.api.ready()]);
    assert.equal(first.events.at(-1).state,'synced');
    first.api.storage.setItem(DRAFT,JSON.stringify({answers:{'CS-1':'-'},currentQuestionId:'CS-1',timer:{minutes:180,remainingMs:9000,endsAt:null}}));
    await first.api.flush();await second.api.refresh();
    assert.equal(second.api.storage.getItem(DRAFT),first.api.storage.getItem(DRAFT));assert.equal(second.changes.at(-1).key,DRAFT);
    assert.equal(server.record('alice',DRAFT).revision,1);
    await first.api.ready();assert.equal(first.api.storage.getItem(DRAFT),second.api.storage.getItem(DRAFT),'ready is idempotent and does not reload stale cache');

    // Raw large notes transfer byte-for-byte; values are never parsed/reformatted.
    const drawing='  {"strokes":[],"padding":"'+ 'x'.repeat(3*1024*1024-100)+'"}\n';
    first.api.storage.setItem(ROUGH,drawing);first.api.storage.setItem(ANNOTATION,'{"parts":{"image-0":[]}}');first.api.storage.setItem('practice-quiz:theme','dark');await first.api.flush();await second.api.refresh();
    assert.equal(second.api.storage.getItem(ROUGH),drawing);assert.equal(second.api.storage.getItem(ANNOTATION),'{"parts":{"image-0":[]}}');

    // Offline edits survive a browser reload and do not leak to another user.
    server.offline=true;first.api.storage.setItem(DRAFT,'offline response');await first.api.persistPending();await assert.rejects(first.api.flush(),/Network/);
    assert.equal(first.events.at(-1).state,'offline');first.api.close();
    const reloaded=device('alice',server,first.cache);await reloaded.api.ready();assert.equal(reloaded.api.storage.getItem(DRAFT),'offline response');assert.equal(reloaded.api.pending(),1);
    const foreign=device('bob',server,first.cache);await assert.rejects(foreign.api.ready(),/Network/);assert.equal(foreign.api.storage.length,0,'Alice cached work is never restored for Bob');
    server.offline=false;await reloaded.api.refresh();await reloaded.api.flush();assert.equal(server.record('alice',DRAFT).value,'offline response');
    const bob=device('bob',server,first.cache);await bob.api.ready();assert.equal(bob.api.storage.length,0);bob.api.storage.setItem(DRAFT,'Bob only');await bob.api.flush();assert.equal(server.record('alice',DRAFT).value,'offline response');
    await second.api.refresh();assert.equal(second.api.storage.getItem(DRAFT),'offline response');

    // Conflicting edits remain on each device until an explicit choice.
    second.api.storage.setItem(DRAFT,'second device edit');reloaded.api.storage.setItem(DRAFT,'first device edit');await reloaded.api.flush();await second.api.flush();
    assert.equal(second.api.conflicts().length,1);assert.equal(second.api.storage.getItem(DRAFT),'second device edit');assert.equal(server.record('alice',DRAFT).value,'first device edit');
    await second.api.resolveConflict(DRAFT,'cloud');assert.equal(second.api.storage.getItem(DRAFT),'first device edit');assert.equal(second.api.pending(),0);
    await reloaded.api.refresh();second.api.storage.setItem(DRAFT,'keep this device');reloaded.api.storage.setItem(DRAFT,'another cloud edit');await reloaded.api.flush();await second.api.flush();
    assert.equal(second.api.conflicts().length,1);await second.api.resolveConflict(DRAFT,'device');assert.equal(server.record('alice',DRAFT).value,'keep this device');assert.equal(second.api.pending(),0);

    // An ACK for an older edit never erases a newer answer/ink operation.
    await reloaded.api.refresh();const committed=deferred(),release=deferred();let firstAck=true;
    server.afterPut=async(uid,body)=>{if(uid==='alice'&&body.key===DRAFT&&firstAck){firstAck=false;committed.resolve();await release.promise;}};
    reloaded.api.storage.setItem(DRAFT,'earlier edit');const sending=reloaded.api.flush();await committed.promise;
    reloaded.api.storage.setItem(DRAFT,'newer edit while saving');await reloaded.api.refresh();
    assert.equal(reloaded.api.conflicts().length,0,'Polling our earlier in-flight write creates no false conflict');assert.equal(reloaded.api.storage.getItem(DRAFT),'newer edit while saving');
    release.resolve();await sending;server.afterPut=null;
    assert.equal(server.record('alice',DRAFT).value,'newer edit while saving','flush drains edits queued during an ACK wait');assert.equal(reloaded.api.pending(),0);

    // A real remote edit during the ACK wait still requires a choice.
    const written=deferred(),respond=deferred();let hold=true;server.afterPut=async(uid,body)=>{if(uid==='alice'&&body.key===DRAFT&&hold){hold=false;written.resolve();await respond.promise;}};
    reloaded.api.storage.setItem(DRAFT,'local intent');const racing=reloaded.api.flush();await written.promise;server.commit('alice',DRAFT,'genuine remote edit');await reloaded.api.refresh();
    assert.equal(reloaded.api.conflicts().length,1);respond.resolve();await racing;server.afterPut=null;
    assert.equal(reloaded.api.pending(),1,'An older successful ACK must retain a pending conflict for keep-device resolution');assert.equal(reloaded.api.storage.getItem(DRAFT),'local intent');
    await reloaded.api.resolveConflict(DRAFT,'device');assert.equal(server.record('alice',DRAFT).value,'local intent');

    // Lost successful responses are idempotent when retried using compare-and-set.
    let lose=true;server.afterPut=async()=>{if(lose){lose=false;throw new TypeError('Response lost after commit');}};
    reloaded.api.storage.setItem(DRAFT,'saved but ACK lost');await assert.rejects(reloaded.api.flush(),/Response lost/);server.afterPut=null;await reloaded.api.flush();
    assert.equal(reloaded.api.conflicts().length,0);assert.equal(reloaded.api.pending(),0);assert.equal(server.record('alice',DRAFT).value,'saved but ACK lost');

    // Explicit import validates every entry before writing and never overwrites work.
    const beforeImport=clone(server.calls);await assert.rejects(reloaded.api.importEntries([[ROUGH,'different drawing'],['practice-quiz:new','new']]),/different progress/);assert.equal(server.calls.length,beforeImport.length);assert.equal(reloaded.api.storage.getItem('practice-quiz:new'),null);
    await assert.rejects(reloaded.api.importEntries([['practice-quiz:new','1'],['practice-quiz:new','2']]),/duplicate/);assert.equal(reloaded.api.storage.getItem('practice-quiz:new'),null);
    await assert.rejects(reloaded.api.importEntries([['unrelated','value']]),/invalid/);
    await reloaded.api.importEntries([['practice-quiz:new','imported'],['practice-quiz:theme','dark']]);assert.equal(server.record('alice','practice-quiz:new').value,'imported');

    // Submit does not resolve until the server ACK, and the browser draft is caller-owned.
    const attemptDone=deferred(),allowAttempt=deferred();server.afterPut=async(uid,body)=>{if(body.key===ATTEMPT){attemptDone.resolve();await allowAttempt.promise;}};
    const currentDraft=reloaded.api.storage.getItem(DRAFT);let resolved=false;
    const submission=reloaded.api.submitAttempt('paper',{version:1,answers:{'CS-1':'A'}}).then(result=>{resolved=true;return result;});await attemptDone.promise;await tick();assert.equal(resolved,false);assert.equal(reloaded.api.storage.getItem(DRAFT),currentDraft);
    allowAttempt.resolve();await submission;server.afterPut=null;assert.equal(reloaded.api.storage.getItem(DRAFT),currentDraft,'Only successful runtime Submit clears the draft, never the sync adapter itself');
    assert.deepEqual(await reloaded.api.getAttempt('paper'),{version:1,answers:{'CS-1':'A'}});
    server.offline=true;await assert.rejects(reloaded.api.submitAttempt('paper',{version:1,answers:{'CS-1':'B'}}),/Network/);assert.equal(reloaded.api.storage.getItem(DRAFT),currentDraft);server.offline=false;
    const pendingSubmission=reloaded.api.storage.getItem(ATTEMPT), beforeReviewReads=reloaded.changes.length;
    assert.deepEqual(await reloaded.api.getAttempt('paper'),{version:1,answers:{'CS-1':'A'}},'Saved Review reads confirmed server submission, never an optimistic failed attempt');
    assert.equal(reloaded.api.storage.getItem(ATTEMPT),pendingSubmission,'Reading saved Review preserves the pending new submission');assert.equal(reloaded.api.pending(),1);assert.equal(reloaded.changes.length,beforeReviewReads,'Verified attempt reads emit no recursive remote UI update');await reloaded.api.flush();
    const notesBeforeReset=reloaded.api.storage.getItem(ROUGH);await reloaded.api.resetAttempts();assert.equal(await reloaded.api.getAttempt('paper'),null);assert.equal(reloaded.api.storage.getItem(ROUGH),notesBeforeReset);assert.equal(reloaded.api.storage.getItem(DRAFT),currentDraft);

    // Server regrading changes summary/results bytes without changing retry intent.
    const canonical=device('dave',server);await canonical.api.ready();
    const intent={version:1,quizId:'paper',quizSignature:'verified key',submittedAt:'2026-11-15T10:00:00.000Z',updatedAt:'2026-11-15T10:00:00.000Z',answers:{'CS-1':'A'},reviewFlags:['CS-1'],outOfSyllabus:[],summary:{score:999},results:['untrusted']};
    server.normalize=(key,value)=>{if(!key.endsWith(':attempt')||value===null)return value;const result=JSON.parse(value);result.summary={score:1,maximum:1,percentage:100};result.results=[{outcome:'correct'}];result.quizTitle='Verified paper';return JSON.stringify(result);};
    let dropCanonical=true;server.afterPut=async(uid)=>{if(uid==='dave'&&dropCanonical){dropCanonical=false;throw new TypeError('Canonical ACK lost');}};
    await assert.rejects(canonical.api.submitAttempt('paper',intent),/ACK lost/);server.afterPut=null;await canonical.api.flush();
    assert.equal(canonical.api.pending(),0);assert.equal(canonical.api.conflicts().length,0,'A canonicalized retry with identical answers/identity is not a conflict');assert.equal((await canonical.api.getAttempt('paper')).summary.score,1);
    const nextIntent={...intent,submittedAt:'2026-11-15T11:00:00.000Z',updatedAt:'2026-11-15T11:00:00.000Z',answers:{'CS-1':'B'}};
    server.afterPut=async(uid)=>{if(uid==='dave')throw new TypeError('Next canonical ACK lost');};await assert.rejects(canonical.api.submitAttempt('paper',nextIntent),/ACK lost/);server.afterPut=null;await canonical.api.refresh();assert.equal(canonical.api.pending(),0);assert.equal(canonical.api.conflicts().length,0,'Refresh also recognizes the same server-regraded attempt');server.normalize=null;

    // Pointer locks protect visible ink that has not reached the storage adapter.
    const lockServer=new Server();lockServer.commit('ink',ROUGH,'initial ink');const locked=device('ink',lockServer);await locked.api.ready();const originalRevision=lockServer.record('ink',ROUGH).revision;
    locked.api.beginEdit(ROUGH);assert.equal(locked.api.isEditing(ROUGH),true);assert.equal(locked.api.isEditing(),true);const changesBeforeStroke=locked.changes.length;
    lockServer.commit('ink',ROUGH,'other device ink');await locked.api.refresh();
    assert.equal(locked.api.pending(),0);assert.equal(locked.api.storage.getItem(ROUGH),'initial ink');assert.equal(locked.changes.length,changesBeforeStroke,'An active unsaved stroke is never repainted by a remote note');assert.equal(locked.api.conflicts().length,1);
    assert.equal(new Map(locked.cache.values.get('ink').revisions).get(ROUGH),originalRevision,'A locked note keeps its pre-stroke compare-and-set revision');
    await assert.rejects(locked.api.resolveConflict(ROUGH,'cloud'),/Finish drawing/);
    locked.api.storage.setItem(ROUGH,'initial ink plus active stroke');locked.api.endEdit(ROUGH);assert.equal(locked.api.isEditing(),false);await locked.api.flush();assert.equal(lockServer.record('ink',ROUGH).value,'other device ink');
    await locked.api.resolveConflict(ROUGH,'device');assert.equal(lockServer.record('ink',ROUGH).value,'initial ink plus active stroke');
    locked.api.beginEdit(ROUGH);lockServer.commit('ink',ROUGH,'keep cloud ink');await locked.api.refresh();locked.api.endEdit(ROUGH);await locked.api.resolveConflict(ROUGH,'cloud');assert.equal(locked.api.storage.getItem(ROUGH),'keep cloud ink');
    locked.api.beginEdit(ROUGH);locked.api.beginEdit(ANNOTATION);locked.api.endEdit(ROUGH);assert.equal(locked.api.isEditing(),true);locked.api.endEdit(ANNOTATION);

    // Scope hydration skips note payloads on Home and rescans metadata on new pages.
    const scopeServer=new Server(),OTHER_NOTE='practice-quiz:other:rough:Q1';scopeServer.commit('scoped',DRAFT,'draft');scopeServer.commit('scoped',ROUGH,'paper ink');scopeServer.commit('scoped',OTHER_NOTE,'other paper ink');scopeServer.commit('scoped','practice-quiz:theme','light');
    const isNote=key=>key.includes(':rough:')||key.includes(':annotation:');
    const home=device('scoped',scopeServer,memoryCache(),{shouldHydrate:key=>!isNote(key)});await home.api.ready();
    assert.equal(home.api.storage.getItem(DRAFT),'draft');assert.equal(home.api.storage.getItem(ROUGH),null);assert.equal(home.api.storage.getItem(OTHER_NOTE),null);
    const noteReads=scopeServer.calls.filter(call=>call.method==='GET'&&new URL(call.address,'https://quiz.example').searchParams.get('key')?.includes(':rough:'));assert.equal(noteReads.length,0,'Home downloads metadata, not drawing payloads');
    assert.equal(new Map(home.cache.values.get('scoped').revisions).has(ROUGH),false,'Skipped payload revisions are not marked as hydrated');
    const previousCursor=home.cache.values.get('scoped').cursor;assert.ok(previousCursor>scopeServer.record('scoped',OTHER_NOTE).revision);
    const scoped=device('scoped',scopeServer,home.cache,{shouldHydrate:key=>!isNote(key)||key.startsWith('practice-quiz:other:')});await scoped.api.ready();
    assert.equal(scoped.api.storage.getItem(OTHER_NOTE),'other paper ink','A prior high cached cursor cannot hide a newly opened quiz note');assert.equal(scoped.api.storage.getItem(ROUGH),null);
    const scopedInitial=scopeServer.calls.filter(call=>call.method==='GET'&&call.address.includes('since='));assert.ok(scopedInitial.filter(call=>call.address.endsWith('since=0')).length>=2);
    const pendingCache=memoryCache(),base=scopeServer.record('scoped',ROUGH).revision;pendingCache.values.set('scoped',{version:1,uid:'scoped',values:[[ROUGH,'offline other paper ink']],revisions:[[ROUGH,base]],pending:[[ROUGH,{value:'offline other paper ink',baseRevision:base,sequence:1}]],cursor:previousCursor,sequence:1});
    const pendingScoped=device('scoped',scopeServer,pendingCache,{shouldHydrate:key=>!isNote(key)});await pendingScoped.api.ready();assert.equal(scopeServer.record('scoped',ROUGH).value,'offline other paper ink','Pending out-of-scope edits are reconciled and synced rather than discarded');

    // Bounded parallel reads improve bootstrap but retain revision application order.
    const parallelServer=new Server();parallelServer.pageSize=100;for(let index=0;index<9;index++)parallelServer.commit('parallel',`practice-quiz:paper-${index}`,'draft '+index);
    let activeReads=0,maxReads=0;parallelServer.beforeGet=async()=>{maxReads=Math.max(maxReads,++activeReads);await tick();activeReads--;};const parallel=device('parallel',parallelServer);await parallel.api.ready();
    assert.ok(maxReads>1&&maxReads<=4,'Hydration uses at most four concurrent payload reads');assert.deepEqual(parallel.changes.map(record=>record.revision),[1,2,3,4,5,6,7,8,9]);

    // Import checks unknown/unhydrated cloud notes and validates all inputs first.
    const importHome=device('scoped',scopeServer,memoryCache(),{shouldHydrate:key=>!isNote(key)});await importHome.api.ready();const writesBefore=scopeServer.calls.filter(call=>call.method==='PUT').length;
    await assert.rejects(importHome.api.importEntries([['practice-quiz:fresh','new draft'],[OTHER_NOTE,'different old note']]),/different progress/);
    assert.equal(scopeServer.calls.filter(call=>call.method==='PUT').length,writesBefore);assert.equal(importHome.api.storage.getItem('practice-quiz:fresh'),null,'A later cloud conflict prevents every import write');
    scopeServer.validate=async body=>{if(body.key==='practice-quiz:bad:rough:Q1')throw fail(400,'Malformed legacy drawing');};
    await assert.rejects(importHome.api.importEntries([['practice-quiz:fresh','valid draft'],['practice-quiz:bad:rough:Q1','bad drawing']]),/Malformed/);assert.equal(importHome.api.pending(),0);assert.equal(scopeServer.record('scoped','practice-quiz:fresh').deleted,true);assert.equal(importHome.api.storage.getItem('practice-quiz:fresh'),null,'Validation of every import completes before any record is queued');scopeServer.validate=null;
    const importCanonical=device('import',scopeServer,memoryCache(),{shouldHydrate:key=>!isNote(key)});await importCanonical.api.ready();scopeServer.normalize=(key,value)=>key.endsWith(':attempt')?JSON.stringify({...JSON.parse(value),summary:{score:1}}):value;
    await importCanonical.api.importEntries([[ATTEMPT,JSON.stringify(intent)],[ROUGH,drawing]]);assert.equal((await importCanonical.api.getAttempt('paper')).summary.score,1,'Imports enqueue the server-validated canonical attempt');assert.equal(scopeServer.record('import',ROUGH).value,drawing);scopeServer.normalize=null;

    // Server validation errors are not mislabeled as an offline connection.
    server.rejectWrite=fail(400,'Invalid numerical draft');reloaded.api.storage.setItem(DRAFT,'rejected but retained');await assert.rejects(reloaded.api.flush(),/Invalid numerical/);assert.equal(reloaded.events.at(-1).state,'error');assert.equal(reloaded.api.storage.getItem(DRAFT),'rejected but retained');server.rejectWrite=null;await reloaded.api.flush();

    // A late response from a signed-out account cannot repaint another session.
    const late=device('carol',server),lateStarted=deferred(),lateRelease=deferred();await late.api.ready();
    server.afterPut=async(uid)=>{if(uid==='carol'){lateStarted.resolve();await lateRelease.promise;}};late.api.storage.setItem(DRAFT,'Carol edit');const lateSend=late.api.flush();await lateStarted.promise;const beforeClose=late.changes.length;late.api.close();lateRelease.resolve();await lateSend;server.afterPut=null;assert.equal(late.changes.length,beforeClose);
    assert.throws(()=>late.api.storage.setItem(DRAFT,'stale edit'),/no longer active/);
    console.log('Cloud sync checks passed: two-device resume, paginated sync, account isolation, offline IndexedDB queue/reload, 3MiB notes, pointer edit locks, scoped hydration, bounded parallel reads, in-flight edit/ACK races, conflicts and lost responses, all-record import validation, Submit/reset guards and rejected writes.');
  } finally {for(const api of devices)api.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
