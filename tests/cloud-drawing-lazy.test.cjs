const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Reuse isolated DOM/canvas fixtures; never open personal notes or browser storage.
function fixture(name) {
  const filename = path.join(__dirname, name);
  let source = fs.readFileSync(filename, 'utf8');
  const marker = name.includes('notebook') ? '\n(async () => {' : '\n// Test cases follow';
  source = source.slice(0, source.indexOf(marker));
  const target = name.includes('notebook') ? 'contextObject.window = contextObject;' : 'context.window = context;';
  const context = name.includes('notebook') ? 'contextObject' : 'context';
  assert.ok(source.includes(target));
  source = source.replace(target, `${target}\n  ${context}.QuizCloudSync = options.cloud;`);
  const module = {exports:{}};
  vm.runInNewContext(source + '\nmodule.exports = {harness, questions, key, record};', {require:createRequire(filename), module, __dirname, console, Buffer, process, setImmediate}, {filename});
  return module.exports;
}
function cloudStore(initial = []) {
  const records = new Map(initial), calls = [], requests = [], writes = [], hydrated = new Set();
  return {records, calls, requests, writes, hydrated, facade:{
    storage:{getItem:key => records.get(key) ?? null, setItem(key,value) { writes.push(key); records.set(key,String(value)); }},
    beginEdit() {}, endEdit() {}, isHydrated:key => hydrated.has(key),
    ensureKeys(keys) { calls.push([...keys]); return new Promise((resolve,reject) => requests.push({key:keys[0],resolve,reject})); }
  }};
}

(async () => {
  for (const kind of ['rough','annotation']) {
    const f = fixture(kind === 'rough' ? 'rough-work-notebook.test.cjs' : 'quiz-annotation.test.cjs');
    const first = f.questions[0].id, second = f.questions[1].id;
    const status = kind === 'rough' ? 'rough-work-status' : 'annotation-status';
    const undo = kind === 'rough' ? 'rough-undo' : 'annotation-undo';
    const redo = kind === 'rough' ? 'rough-redo' : 'annotation-redo';
    const clear = kind === 'rough' ? 'rough-clear' : 'annotation-clear';
    const pen = kind === 'rough' ? 'rough-tool-pen' : 'annotation-tool-pen';
    const width = kind === 'rough' ? 'rough-work-width' : 'annotation-width';
    const surface = h => kind === 'rough' ? h.canvas : h.canvas(h.regions[1].hidden ? h.regions[0] : h.regions[1]);
    const show = h => kind === 'rough' ? h.notebook.show(first) : h.ids['screen-annotation-toggle'].click();
    const close = h => kind === 'rough' ? h.notebook.hide() : h.ids['annotation-done'].click();
    const draw = h => { if (kind === 'rough') h.draw(); else h.draw(h.regions[1].hidden ? h.regions[0] : h.regions[1]); h.flush(); };
    const count = (cloud,id=first) => {
      const saved = JSON.parse(cloud.records.get(f.key(id)));
      return kind === 'rough' ? saved.strokes.length : Object.values(saved.parts).flat().length;
    };
    const finish = async (h,cloud,request,value) => {
      const raw = value === null ? null : JSON.stringify(value);
      if (raw === null) cloud.records.delete(request.key); else cloud.records.set(request.key,raw);
      cloud.hydrated.add(request.key);
      h.windowEvent('quiz-cloud-record',{detail:{key:request.key,value:raw}});
      request.resolve(); await tick(); h.flush();
    };

    // Unknown notes gate only drawing while remote history loads, once per visible question.
    const cloud = cloudStore(), h = f.harness({cloud:cloud.facade});
    if (kind === 'rough') assert.equal(cloud.calls.length,0,'Closed notebook fetches no notes');
    else {
      assert.equal(h.ids['screen-annotation-toolbar'].hidden,true);
      assert.deepEqual(cloud.calls,[[f.key(first)]],'Passive marks load once despite multiple visible parts; hidden questions stay lazy');
    }
    show(h); h.flush();
    assert.match(h.ids[status].textContent,/Loading/);
    assert.equal(h.ids[pen].disabled,true); assert.equal(h.ids[width].disabled,true);
    if (kind === 'rough') assert.equal(h.ids['rough-work-paper'].disabled,true);
    draw(h); h.ids[clear].click(); h.ids[undo].click();
    assert.equal(cloud.writes.length,0,'Loading never saves an empty replacement over unknown marks');
    assert.equal(surface(h).getAttribute('aria-disabled'),'true');
    const firstRequest = cloud.requests[0];
    if (kind === 'rough') h.notebook.show(second);
    else { h.regions[0].hidden=true; h.regions[1].hidden=false; h.controller.setCurrent(second); h.flush(); }
    assert.equal(cloud.calls.length,2,'Question navigation remains usable during the earlier fetch');
    await finish(h,cloud,firstRequest,f.record(first));
    assert.match(h.ids[status].textContent,/Loading/,'Late old-question result cannot unlock the current page');
    assert.equal(h.ids[pen].disabled,true);
    await finish(h,cloud,cloud.requests[1],null);
    assert.equal(h.ids[pen].disabled,false,'Confirmed missing pages become editable');
    assert.equal(surface(h).getAttribute('aria-disabled'),'false');
    assert.equal(cloud.writes.length,0,'Hydration and navigation never rewrite notes');

    // Existing marks appear even without opening the screen-annotation toolbar.
    const passiveCloud = cloudStore(), passive = f.harness({cloud:passiveCloud.facade});
    if (kind === 'rough') show(passive);
    const before = passive.drawing.filter(item => item.type === 'stroke').length;
    await finish(passive,passiveCloud,passiveCloud.requests[0],f.record(first));
    assert.ok(passive.drawing.filter(item => item.type === 'stroke').length > before,'Fetched existing ink renders immediately');
    if (kind === 'annotation') assert.equal(passive.ids['screen-annotation-toolbar'].hidden,true,'Existing marks render with tools closed');

    // A failed unknown page stays protected; explicit reopening retries without an empty save.
    const failedCloud = cloudStore(), failed = f.harness({cloud:failedCloud.facade});
    show(failed); failedCloud.requests[0].reject(Error('Offline')); await tick(); failed.flush();
    assert.match(failed.ids[status].textContent,/Could not load account/);
    assert.equal(failed.ids[pen].disabled,true); draw(failed);
    assert.equal(failedCloud.writes.length,0);
    close(failed); show(failed); failed.flush();
    assert.equal(failedCloud.calls.length,2,'Reopening explicitly retries failed hydration');
    await finish(failed,failedCloud,failedCloud.requests[1],f.record(first));
    draw(failed); assert.equal(count(failedCloud),2,'Retry restores old ink before allowing new ink');

    // Valid cached notes remain visible and editable offline, including while refresh is pending.
    const cachedCloud = cloudStore([[f.key(first),JSON.stringify(f.record(first))]]), cached = f.harness({cloud:cachedCloud.facade});
    show(cached); cached.flush();
    assert.equal(cached.ids[pen].disabled,false,'A validated cached page stays usable while checking the server');
    draw(cached); assert.equal(count(cachedCloud),2);
    cachedCloud.requests[0].reject(Error('Offline')); await tick(); cached.flush();
    assert.match(cached.ids[status].textContent,/Using saved.*edits will queue for sync/);
    assert.equal(cached.ids[pen].disabled,false);
    draw(cached); assert.equal(count(cachedCloud),3,'Offline drawing preserves existing ink and queues the new stroke');

    // Re-reading unchanged bytes must preserve undo/redo and edits made during the request.
    const sameCloud = cloudStore([[f.key(first),JSON.stringify(f.record(first))]]), same = f.harness({cloud:sameCloud.facade});
    show(same); draw(same); same.ids[undo].click();
    assert.equal(same.ids[redo].disabled,false);
    const sameRaw = JSON.parse(sameCloud.records.get(f.key(first)));
    await finish(same,sameCloud,sameCloud.requests[0],sameRaw);
    assert.equal(same.ids[redo].disabled,false,'Unchanged hydration keeps the in-session redo history');
    same.ids[redo].click(); assert.equal(count(sameCloud),2);

    // Malformed cached/remote notes remain untouched and cannot be replaced with blank pages.
    const invalidCloud = cloudStore([[f.key(first),'{"invalid":true}']]), invalid = f.harness({cloud:invalidCloud.facade});
    show(invalid); await finish(invalid,invalidCloud,invalidCloud.requests[0],{invalid:true});
    assert.equal(invalid.ids[pen].disabled,true);
    draw(invalid); invalid.ids[clear].click();
    assert.equal(invalidCloud.writes.length,0);
    assert.equal(invalidCloud.records.get(f.key(first)),'{"invalid":true}');
  }
  console.log('Cloud lazy drawing hydration: pass');
})().catch(error => { console.error(error); process.exitCode=1; });
