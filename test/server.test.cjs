'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {makeServer, exportCSV} = require('../server.cjs');

const INPUT = {
  videoUrl: 'https://www.douyin.com/video/1234567890123456789',
  target: 'https://www.douyin.com/user/MS4wLjABAAAAtarget123',
  maxMinutes: 5,
  maxComments: 1000,
};
const emptyResult = () => ({
  verdict: 'incomplete', complete: false, reason: '尚未读取全部回复', matches: [],
  stats: {comments: 0, replies: 0, unresolved: 0}, diagnostics: ['尚未读取全部回复'],
});

async function fixture(t, options = {}) {
  const instances = [];
  class FakeScanner {
    constructor(job, publish) { this.job = job; this.publish = publish; this.resumeCalls = 0; this.closed = false; instances.push(this); }
    async start() { this.job.phase = 'scanning'; this.publish(this.job); }
    async resume() { this.resumeCalls++; this.job.status = 'running'; this.publish(this.job); }
    async stop() { this.job.status = 'finished'; this.job.phase = 'done'; this.job.result ||= emptyResult(); this.publish(this.job); }
    async fail(error) { this.job.message = error.message; await this.stop(); }
    async close() { if (this.closeHook) await this.closeHook(); this.closed = true; }
    set(values) { Object.assign(this.job, values); this.publish(this.job); }
  }
  const app = makeServer({...options, Scanner: FakeScanner});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const port = app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const request = (method, route, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({hostname:'127.0.0.1', port, method, path: route, headers: {
      ...(method === 'POST' ? {'Content-Type':'application/json', Origin: origin} : {}), ...headers,
    }}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch {}
        resolve({status:res.statusCode, headers:res.headers, text, json});
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  return {instances, request, origin, close:app.close};
}

function temporaryStateFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcf-state-test-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return path.join(dir, 'last-job.json');
}

test('idle state and export accurately report that no inspection exists', async t => {
  const {request, instances} = await fixture(t);
  const state = await request('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.appId, 'douyin-comment-finder');
  assert.equal(state.json.version, '1.2.0');
  assert.equal(state.json.job, null);
  for (const format of ['json', 'csv']) {
    const response = await request('GET', `/api/export?format=${format}`);
    assert.equal(response.status, 409);
    assert.match(response.json.error, /尚无/);
  }
  assert.equal(instances.length, 0);
});

test('rejects non-Douyin and unsafe inputs before constructing a scanner', async t => {
  const {request, instances} = await fixture(t);
  for (const videoUrl of [
    'https://example.com/video/1234567890123456789',
    'https://www.douyin.com.evil.test/video/1234567890123456789',
    'http://www.douyin.com/video/1234567890123456789',
    'https://user:password@www.douyin.com/video/1234567890123456789',
    'https://127.0.0.1/video/1234567890123456789',
  ]) {
    assert.equal((await request('POST', '/api/start', {...INPUT, videoUrl})).status, 400, videoUrl);
  }
  for (const target of ['https://example.com/user/target', 'https://v.douyin.com/target/']) {
    assert.equal((await request('POST', '/api/start', {...INPUT, target})).status, 400, target);
  }
  assert.equal(instances.length, 0);
  assert.equal((await request('GET', '/api/state')).json.job, null);
});

test('rejects cross-origin mutations, foreign hosts and non-JSON requests', async t => {
  const {request, instances} = await fixture(t);
  assert.equal((await request('POST', '/api/start', INPUT, {Origin:'https://evil.example'})).status, 403);
  assert.equal((await request('POST', '/api/start', INPUT, {Origin:'null'})).status, 403);
  assert.equal((await request('GET', '/api/state', undefined, {Host:'evil.example'})).status, 403);
  assert.equal((await request('POST', '/api/start', INPUT, {'Content-Type':'text/plain'})).status, 415);
  assert.equal(instances.length, 0);
});

test('single active job, waiting resume and stop preserve job identity and status', async t => {
  const {request, instances} = await fixture(t);
  const first = await request('POST', '/api/start', INPUT);
  assert.equal(first.status, 202);
  const id = first.json.job.id;
  assert.equal(first.json.job.status, 'running');
  assert.equal((await request('POST', '/api/start', INPUT)).status, 409);
  assert.equal((await request('POST', '/api/continue', {})).status, 409);
  instances[0].set({status:'waiting', phase:'comments'});
  assert.equal((await request('POST', '/api/start', INPUT)).status, 409);
  assert.equal((await request('POST', '/api/continue', {})).status, 202);
  assert.equal(instances[0].resumeCalls, 1);
  assert.equal((await request('GET', '/api/state')).json.job.status, 'running');
  const stopped = await request('POST', '/api/stop', {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.job.id, id);
  assert.equal(stopped.json.job.status, 'finished');
  assert.equal(stopped.json.job.result.verdict, 'incomplete');
  assert.equal(instances.length, 1);
});

test('simultaneous initial start requests create exactly one scanner', async t => {
  const {request, instances} = await fixture(t);
  const responses = await Promise.all([request('POST','/api/start',INPUT), request('POST','/api/start',INPUT)]);
  assert.deepEqual(responses.map(r=>r.status).sort(), [202,409]);
  assert.equal(instances.length, 1);
});

test('simultaneous restarts remain exclusive while old browser is closing', async t => {
  const {request, instances} = await fixture(t);
  await request('POST', '/api/start', INPUT);
  await request('POST', '/api/stop', {});
  let releaseClose, enteredClose;
  const closeStarted = new Promise(resolve => { enteredClose = resolve; });
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  instances[0].closeHook = () => { enteredClose(); return closeGate; };
  const restarting = request('POST', '/api/start', INPUT);
  await closeStarted;
  let second;
  // Release even when the implementation accidentally admits both requests.
  const releaseTimer = setTimeout(releaseClose, 200);
  try { second = await request('POST', '/api/start', INPUT); }
  finally { clearTimeout(releaseTimer); releaseClose(); }
  const first = await restarting;
  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  assert.equal(instances.length, 2);
  assert.equal(instances[0].closed, true);
});

test('exports incomplete empty results without turning them into negative findings', async t => {
  const {request, instances} = await fixture(t);
  await request('POST', '/api/start', INPUT);
  instances[0].set({status:'waiting', result:emptyResult()});
  const json = await request('GET','/api/export?format=json');
  assert.equal(json.status, 200);
  assert.equal(json.json.jobStatus, 'waiting');
  assert.equal(json.json.verdict, 'incomplete');
  assert.equal(json.json.complete, false);
  assert.deepEqual(json.json.matches, []);
  assert.match(json.headers['content-disposition'], /attachment; filename="douyin-comments-.*\.json"/);
  const csv = await request('GET','/api/export?format=csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.text.startsWith('\uFEFF'));
  assert.match(csv.text, /"检索结论","incomplete","范围完整","false"/);
  assert.match(csv.text, /尚未读取全部回复/);
  assert.equal((await request('GET','/api/export?format=html')).status, 400);
});

test('CSV export escapes formulas, embedded quotes, newlines and preserves findings', async t => {
  const {request, instances} = await fixture(t);
  await request('POST','/api/start',INPUT);
  const result = {...emptyResult(), verdict:'found', matches:[{
    id:'123', text:' =HYPERLINK("https://example.test","内容")\n第二行', time:1234567890,
    videoId:'1234567890123456789', parentId:null, authorUrl:'https://www.douyin.com/user/MS4wLjABAAAAtarget123', matchBy:'sec_uid',
  }]};
  instances[0].set({status:'finished', result});
  const json = await request('GET','/api/export?format=json');
  assert.equal(json.json.jobStatus,'finished');
  assert.equal(json.json.verdict,'found');
  assert.equal(json.json.complete,false);
  assert.equal(json.json.matches[0].text,result.matches[0].text);
  const csv = await request('GET','/api/export?format=csv');
  assert.match(csv.text,/"检索结论","found","范围完整","false"/);
  assert.ok(csv.text.includes('"\' =HYPERLINK(""https://example.test"",""内容"")\n第二行"'));
  for (const text of ['=1+1','+1+1','-1+1','@SUM(A1:A2)','\t=1+1']) {
    assert.ok(exportCSV({...emptyResult(),matches:[{text}]}).includes(`"'${text}"`), text);
  }
});

test('unknown routes and private application files cannot be downloaded', async t => {
  const {request, instances} = await fixture(t);
  for (const route of ['/api/unknown','/server.cjs','/.local/browser/Cookies','/../server.cjs','/%2e%2e/server.cjs']) {
    assert.equal((await request('GET',route)).status,404,route);
  }
  assert.equal((await request('POST','/api/unknown',{})).status,404);
  assert.equal((await request('PUT','/api/state')).status,405);
  assert.equal(instances.length,0);
});

test('session mode defaults to saved and explicit guest or saved reaches scanner, state and exports', async t => {
  const {request, instances} = await fixture(t);
  for (const mode of [undefined, 'guest', 'saved']) {
    const expected = mode || 'saved';
    const started = await request('POST', '/api/start', {...INPUT, ...(mode ? {sessionMode:mode} : {})});
    assert.equal(started.status, 202);
    assert.equal(started.json.job.sessionMode, expected);
    assert.equal(instances.at(-1).job.sessionMode, expected);
    assert.equal((await request('GET','/api/state')).json.job.sessionMode, expected);
    await request('POST', '/api/stop', {});
    assert.equal((await request('GET','/api/export?format=json')).json.sessionMode, expected);
    assert.ok((await request('GET','/api/export?format=csv')).text.includes(`"浏览器会话","${expected}"`));
  }
});

test('invalid session modes are rejected before any browser session is created', async t => {
  const {request, instances} = await fixture(t);
  for (const sessionMode of ['', 'incognito', 'GUEST', true, null, ['guest'], {mode:'guest'}]) {
    const result = await request('POST', '/api/start', {...INPUT, sessionMode});
    assert.equal(result.status, 400);
    assert.match(result.json.error, /会话/);
  }
  assert.equal(instances.length, 0);
  assert.equal((await request('GET','/api/state')).json.job, null);
});

test('a restarted unfinished job retains matches and session mode without implying a completed scan', async t => {
  const stateFile = temporaryStateFile(t);
  const original = await fixture(t, {stateFile});
  const started = await original.request('POST', '/api/start', {...INPUT, sessionMode:'guest'});
  const match = {id:'saved-match', text:'保留命中的评论', videoId:'1234567890123456789', matchBy:'sec_uid'};
  original.instances[0].set({status:'waiting', result:{...emptyResult(), verdict:'found', matches:[match]}});
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(persisted.job.sessionMode, 'guest');
  assert.equal(persisted.job.status, 'waiting');
  await original.close();

  const restored = await fixture(t, {stateFile});
  const state = (await restored.request('GET','/api/state')).json;
  assert.equal(state.job.id, started.json.job.id);
  assert.equal(state.job.sessionMode, 'guest');
  assert.equal(state.job.status, 'finished');
  assert.equal(state.job.phase, 'done');
  assert.equal(state.job.result.verdict, 'found');
  assert.equal(state.job.result.complete, false);
  assert.deepEqual(state.job.result.matches, [match]);
  assert.match(state.job.result.reason, /重启/);
  assert.equal(restored.instances.length, 0);
  assert.equal((await restored.request('POST','/api/continue',{})).status, 409);
  const report = (await restored.request('GET','/api/export?format=json')).json;
  assert.equal(report.sessionMode, 'guest');
  assert.deepEqual(report.matches, [match]);
  assert.equal(report.complete, false);
  assert.equal((await restored.request('POST','/api/start',INPUT)).status, 202);
});

test('a restart before any data arrives produces an incomplete result rather than not_found', async t => {
  const stateFile = temporaryStateFile(t);
  const original = await fixture(t, {stateFile});
  await original.request('POST','/api/start',INPUT);
  await original.close();
  const restored = await fixture(t, {stateFile});
  const job = (await restored.request('GET','/api/state')).json.job;
  assert.equal(job.status, 'finished');
  assert.equal(job.result.verdict, 'incomplete');
  assert.equal(job.result.complete, false);
  assert.deepEqual(job.result.matches, []);
  assert.equal(job.sessionMode, 'saved');
});

test('finished results survive a restart without changing a valid completed verdict', async t => {
  const stateFile = temporaryStateFile(t);
  const original = await fixture(t, {stateFile});
  await original.request('POST','/api/start',INPUT);
  const result = {...emptyResult(), verdict:'not_found', complete:true, reason:'检查完成', diagnostics:[]};
  original.instances[0].set({status:'finished', phase:'done', result});
  await original.close();
  const restored = await fixture(t, {stateFile});
  assert.deepEqual((await restored.request('GET','/api/state')).json.job.result, result);
});

test('a damaged history file does not block a fresh check or leak its contents', async t => {
  const stateFile = temporaryStateFile(t);
  fs.writeFileSync(stateFile, '{"private":broken', 'utf8');
  const {request, instances} = await fixture(t, {stateFile});
  const state = await request('GET','/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.job, null);
  assert.doesNotMatch(state.text, /private|broken/);
  assert.equal((await request('POST','/api/start',INPUT)).status, 202);
  assert.equal(instances.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(stateFile,'utf8')).appId, 'douyin-comment-finder');
});

test('reply threshold defaults to 100 and reaches scanner, state and exports at supported boundaries', async t => {
  const {request, instances} = await fixture(t);
  for (const threshold of [undefined, 0, 1, 10000]) {
    const expected = threshold ?? 100;
    const response = await request('POST','/api/start',{...INPUT,...(threshold === undefined ? {} : {replyThreshold:threshold})});
    assert.equal(response.status, 202);
    assert.equal(response.json.job.replyThreshold, expected);
    assert.equal(instances.at(-1).job.replyThreshold, expected);
    assert.equal((await request('GET','/api/state')).json.job.replyThreshold, expected);
    await request('POST','/api/stop',{});
    assert.equal((await request('GET','/api/export?format=json')).json.replyThreshold, expected);
    assert.ok((await request('GET','/api/export?format=csv')).text.includes(`"全量检索阈值","${expected}"`));
  }
});

test('invalid reply thresholds are rejected before constructing a scanner', async t => {
  const {request, instances} = await fixture(t);
  for (const replyThreshold of [-1, 10001, 1.5, null, true, '100', [], {count:100}]) {
    const response = await request('POST','/api/start',{...INPUT,replyThreshold});
    assert.equal(response.status, 400, JSON.stringify(replyThreshold));
    assert.match(response.json.error, /阈值/);
  }
  assert.equal(instances.length, 0);
});

test('a completed primary-comment scope exports an explicitly limited negative finding', async t => {
  const {request, instances} = await fixture(t);
  await request('POST','/api/start',{...INPUT,replyThreshold:100});
  const coverage = {scope:'main_only',scopeComplete:true,allCommentsComplete:false,replyThreshold:100,observedTotal:130,repliesSkipped:true};
  instances[0].set({status:'finished',result:{...emptyResult(),verdict:'not_found',complete:true,
    reason:'一级评论中未找到匹配；楼中楼未检索',coverage}});
  const report = (await request('GET','/api/export?format=json')).json;
  assert.equal(report.complete, true);
  assert.deepEqual(report.coverage, coverage);
  assert.equal(report.coverage.allCommentsComplete, false);
  const csv = (await request('GET','/api/export?format=csv')).text;
  assert.match(csv, /"范围完整","true"/);
  assert.match(csv, /"检索范围","仅一级评论（楼中楼未检索）"/);
  assert.match(csv, /"全部评论完整","false"/);
  const page = (await request('GET','/')).text;
  const script = (await request('GET','/app.js')).text;
  assert.doesNotMatch(page, /id="continue-button"/);
  assert.doesNotMatch(script, /continue-button|action\('\/api\/continue'/);
  assert.match(page, /id="reply-threshold"/);
  assert.match(page, /随后会自动恢复检查/);
});

test('shutdown enforces origin checks and waits for browser close before responding and persisting', async t => {
  const stateFile = temporaryStateFile(t);
  const original = await fixture(t, {stateFile});
  await original.request('POST','/api/start', {...INPUT,replyThreshold:250});
  original.instances[0].set({status:'waiting',result:{...emptyResult(),coverage:{scope:'main_only',scopeComplete:false,allCommentsComplete:false}}});
  assert.equal((await original.request('POST','/api/shutdown',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal(original.instances[0].closed,false);
  let release, entered;
  const closingStarted = new Promise(resolve => { entered = resolve; });
  const closingGate = new Promise(resolve => { release = resolve; });
  let closeCalls = 0;
  original.instances[0].closeHook = () => { closeCalls++; entered(); return closingGate; };
  let responded = false;
  const shutdown = original.request('POST','/api/shutdown',{}).then(result => { responded = true; return result; });
  await closingStarted;
  assert.equal(responded,false);
  assert.equal(original.instances[0].closed,false);
  assert.equal((await original.request('POST','/api/start',INPUT)).status,503);
  release();
  const response = await shutdown;
  assert.equal(response.status,200);
  assert.deepEqual(response.json,{closed:true});
  assert.equal(original.instances[0].closed,true);
  await original.close();
  assert.equal(closeCalls,1);
  assert.equal(JSON.parse(fs.readFileSync(stateFile,'utf8')).job.replyThreshold,250);

  const restored = await fixture(t,{stateFile});
  const job = (await restored.request('GET','/api/state')).json.job;
  assert.equal(job.status,'finished');
  assert.equal(job.replyThreshold,250);
  assert.equal(job.result.complete,false);
  assert.equal(job.result.coverage.scopeComplete,false);
  assert.equal(job.result.coverage.allCommentsComplete,false);
  assert.match(job.result.reason,/重启/);
});
