'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {BrowserScanner, classifyPageEvidence} = require('../lib/browser.cjs');
const {ScanLedger} = require('../lib/domain.cjs');

const VIDEO_ID = '1234567890123456789';
const COMMENT_URL = `https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=${VIDEO_ID}&cursor=0`;
const PROFILE = 'https://www.douyin.com/user/MS4wLjABAAAAtarget123';

function fixture(sessionMode = 'guest', target = PROFILE, options = {}) {
  const job = {
    id:'guest-regression', videoUrl:`https://www.douyin.com/video/${VIDEO_ID}`,
    target, sessionMode, status:'running', phase:'init', logs:[],
    maxMinutes:5, maxComments:1000,
  };
  const scanner = new BrowserScanner(job, () => {}, {delay:async () => {}, ...options});
  return {scanner, job};
}

function browserMock() {
  const calls = [];
  const contextEvents = new Map();
  const pageEvents = new Map();
  const page = {
    setDefaultTimeout() {},
    on(name, handler) { pageEvents.set(name, handler); return page; },
    url:() => 'about:blank',
    isClosed:() => false,
  };
  const context = {
    pages:() => [page],
    newPage:async () => page,
    on(name, handler) { contextEvents.set(name, handler); return context; },
    close:async () => { calls.push({method:'context.close'}); },
  };
  const browser = {
    newContext:async options => { calls.push({method:'browser.newContext', options}); return context; },
    close:async () => { calls.push({method:'browser.close'}); },
  };
  const chromium = {
    launch:async options => { calls.push({method:'chromium.launch', options}); return browser; },
    launchPersistentContext:async (profile, options) => {
      calls.push({method:'chromium.launchPersistentContext', profile, options});
      return context;
    },
  };
  return {calls, contextEvents, pageEvents, page, context, playwright:{chromium}};
}

function temporaryProfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcf-guest-test-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return path.join(dir, 'profile');
}

for (const mode of ['guest', 'saved']) {
  test(`${mode} handle searches go straight to the supplied video without a login-gated account search`, async () => {
    const {scanner, job} = fixture(mode, 'target_account_123');
    const steps = [];
    scanner.page = {goto:async () => { assert.fail('start must not navigate to account search'); }};
    scanner.launch = async () => { steps.push('launch'); };
    scanner.openVideo = async () => { steps.push('openVideo'); };
    await scanner.start();
    assert.deepEqual(steps, ['launch', 'openVideo']);
    assert.notEqual(job.phase, 'identity');
    assert.notEqual(job.status, 'waiting');
    assert.equal(scanner.identity, null);
  });
}

test('guest launch uses a fresh context and never creates or opens a saved profile', async t => {
  const mock = browserMock();
  const profileDir = temporaryProfile(t);
  const {scanner} = fixture('guest', PROFILE, {playwright:mock.playwright, profileDir});
  await scanner.launch();
  assert.equal(mock.calls.filter(x => x.method === 'chromium.launch').length, 1);
  assert.equal(mock.calls.filter(x => x.method === 'browser.newContext').length, 1);
  assert.equal(mock.calls.filter(x => x.method === 'chromium.launchPersistentContext').length, 0);
  assert.equal(fs.existsSync(profileDir), false);
  assert.equal(scanner.context, mock.context);
  const newContext = mock.calls.find(x => x.method === 'browser.newContext');
  assert.equal(newContext.options.storageState, undefined);
  await scanner.close();
  assert.equal(mock.calls.filter(x => x.method === 'browser.close').length, 1);
});

test('saved launch uses the explicit persistent profile and closes that context', async t => {
  const mock = browserMock();
  const profileDir = temporaryProfile(t);
  const {scanner} = fixture('saved', PROFILE, {playwright:mock.playwright, profileDir});
  await scanner.launch();
  const persistent = mock.calls.filter(x => x.method === 'chromium.launchPersistentContext');
  assert.equal(persistent.length, 1);
  assert.equal(persistent[0].profile, profileDir);
  assert.equal(mock.calls.filter(x => x.method === 'chromium.launch').length, 0);
  await scanner.close();
  assert.equal(mock.calls.filter(x => x.method === 'context.close').length, 1);
});

test('comment responses are observed at context scope, including a second browser tab', async t => {
  const mock = browserMock();
  const {scanner} = fixture('guest', PROFILE, {
    playwright:mock.playwright, profileDir:temporaryProfile(t),
  });
  await scanner.launch();
  assert.equal(typeof mock.contextEvents.get('response'), 'function');
  assert.equal(mock.pageEvents.has('response'), false);
  scanner.ledger = new ScanLedger(VIDEO_ID, scanner.target);
  // The event belongs to another tab; no listener is installed on that page.
  mock.contextEvents.get('response')({
    url:() => COMMENT_URL, status:() => 200,
    json:async () => ({status_code:0, cursor:0, has_more:0, total:1, comments:[{
      cid:'second-tab-comment', aweme_id:VIDEO_ID, text:'匹配评论', reply_comment_total:0,
      user:{uid:'target-uid', sec_uid:'MS4wLjABAAAAtarget123'},
    }]}),
  });
  await Promise.all([...scanner.pending]);
  const result = scanner.ledger.snapshot();
  assert.equal(result.verdict, 'found');
  assert.equal(result.matches[0].id, 'second-tab-comment');
  await scanner.close();
});

const baseEvidence = {
  loginWall:false, verification:false, unavailable:false,
  commentPanel:false, visibleComments:0, guest:true,
};
const baseDiagnostics = {
  httpStatus:null, nonJson:false, responseCount:0,
  lastAcceptedAt:0, identityError:null,
};

test('a visible login button or guest state alone never diagnoses a login wall', () => {
  const result = classifyPageEvidence(baseEvidence, baseDiagnostics, true);
  assert.equal(result.code, 'comments_not_open');
  assert.notEqual(result.code, 'login_required');
});

test('missing network responses with an open comment panel are not blamed on login', () => {
  const result = classifyPageEvidence({...baseEvidence, commentPanel:true}, baseDiagnostics, true);
  assert.equal(result.code, 'no_response');
  assert.notEqual(result.code, 'login_required');
});

test('actual access evidence distinguishes verification, login wall, and unavailable videos', () => {
  for (const [property, code] of [
    ['verification','verification'], ['loginWall','login_required'], ['unavailable','video_unavailable'],
  ]) {
    const result = classifyPageEvidence({...baseEvidence, [property]:true}, baseDiagnostics, true);
    assert.equal(result.code, code);
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 0);
  }
});

test('a successful retry clears a previous HTTP rejection instead of permanently poisoning coverage', async () => {
  const {scanner} = fixture();
  scanner.ledger = new ScanLedger(VIDEO_ID, scanner.target);
  await scanner.onResponse({url:() => COMMENT_URL, status:() => 403});
  await scanner.onResponse({
    url:() => COMMENT_URL, status:() => 200,
    json:async () => ({status_code:0, cursor:0, has_more:0, total:0, comments:[]}),
  });
  const result = scanner.ledger.snapshot();
  assert.equal(result.verdict, 'not_found');
  assert.equal(result.complete, true);
  assert.equal(scanner.diagnostics.httpStatus, null);
});

for (const moved of [false,true]) {
  test(`continue ${moved ? 'returns from another page to the original work' : 'reloads a failed first page'} before opening comments`, async () => {
    const {scanner,job}=fixture();
    const steps=[];
    scanner.ledger=new ScanLedger(VIDEO_ID,scanner.target);
    job.status='waiting';
    job.resolvedVideoUrl=`https://www.douyin.com/note/${VIDEO_ID}`;
    scanner.page={
      url:()=>moved ? 'https://www.douyin.com/' : job.resolvedVideoUrl,
      reload:async()=>{steps.push('reload');},
      goto:async url=>{assert.equal(url,job.resolvedVideoUrl);steps.push('goto');},
    };
    scanner.openComments=async()=>{steps.push('comments');};
    scanner.runScan=async()=>{steps.push('scan');};
    await scanner.resume();
    assert.deepEqual(steps,[moved?'goto':'reload','comments','scan']);
    assert.equal(scanner.resuming,false);
  });
}

test('a transient document navigation recovers without failing the scan', async()=>{
  const {scanner}=fixture();
  let calls=0,waits=0;
  scanner.page={waitForLoadState:async()=>{waits++;}};
  const result=await scanner.withPageReady(async()=>{
    if(++calls===1) throw new Error('Execution context was destroyed, most likely because of a navigation');
    return 'ready';
  });
  assert.equal(result,'ready'); assert.equal(calls,2); assert.equal(waits,1);
});

test('unrelated page errors are not hidden as navigation retries', async()=>{
  const {scanner}=fixture();
  let calls=0;
  scanner.page={waitForLoadState:async()=>{assert.fail('must not retry');}};
  await assert.rejects(scanner.withPageReady(async()=>{calls++;throw new Error('Unexpected adapter failure');}),/adapter failure/);
  assert.equal(calls,1);
});

test('an explicit login wall overrides a terminal empty response, and successful login can recover', async()=>{
  const {scanner,job}=fixture();
  scanner.ledger=new ScanLedger(VIDEO_ID,scanner.target);
  scanner.ledger.ingest(COMMENT_URL,{status_code:0,cursor:0,has_more:0,total:0,comments:[]});
  assert.equal(scanner.ledger.snapshot().complete,true);
  let loginWall=true;
  scanner.page={
    url:()=>`https://www.douyin.com/note/${VIDEO_ID}`,
    evaluate:async()=>({...baseEvidence,commentPanel:true,loginWall}),
  };
  let resumed=0;
  scanner.reloadVideo=async()=>{resumed++;};
  scanner.delay=async()=>{
    assert.equal(job.status,'waiting');
    assert.equal(job.phase,'login_required');
    assert.equal(job.result.complete,false);
    assert.equal(job.result.verdict,'incomplete');
    loginWall=false;
  };
  await scanner.runScan();
  assert.equal(resumed,1);
  assert.equal(job.status,'finished');
  assert.equal(job.result.complete,true);
  assert.equal(job.result.verdict,'not_found');
});
