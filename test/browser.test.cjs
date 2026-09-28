'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {BrowserScanner} = require('../lib/browser.cjs');
const {ScanLedger} = require('../lib/domain.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function fixture() {
  const job = {
    id:'test-job', videoUrl:'https://www.douyin.com/video/1234567890123456789',
    target:'https://www.douyin.com/user/MS4wLjABAAAAtarget123',
    status:'running', phase:'init', logs:[], maxMinutes:5, maxComments:1000,
  };
  const published = [];
  const scanner = new BrowserScanner(job, updated => published.push(JSON.parse(JSON.stringify(updated))));
  return {scanner, job, published};
}

test('runScan after stop preserves the finished job and does not enter a scan loop', async () => {
  const {scanner, job, published} = fixture();
  await scanner.stop();
  const stoppedState = JSON.stringify(job);
  const publications = published.length;
  let loops = 0;
  scanner._scanLoop = async () => { loops++; };
  await scanner.runScan();
  assert.equal(loops, 0);
  assert.equal(job.status, 'finished');
  assert.equal(job.phase, 'done');
  assert.equal(JSON.stringify(job), stoppedState);
  assert.equal(published.length, publications);
});

test('late waiting/running updates cannot revive a stopped job', async () => {
  const {scanner, job, published} = fixture();
  await scanner.stop();
  const stoppedState = JSON.stringify(job);
  const publications = published.length;
  scanner.update('comments', '延迟到达的等待提示', 'waiting');
  scanner.update('scanning', '延迟到达的扫描提示');
  assert.equal(JSON.stringify(job), stoppedState);
  assert.equal(published.length, publications);
});

test('a comment JSON response completing after stop cannot update ledger or result', async () => {
  const {scanner, job, published} = fixture();
  scanner.ledger = new ScanLedger('1234567890123456789', scanner.target);
  const json = deferred();
  const response = {
    url:() => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=1234567890123456789&cursor=0',
    status:() => 200,
    json:() => json.promise,
  };
  const handling = scanner.onResponse(response);
  await scanner.stop();
  const stoppedState = JSON.stringify(job);
  const publications = published.length;
  json.resolve({status_code:0, cursor:1, has_more:0, total:1, comments:[{
    cid:'comment-1', aweme_id:'1234567890123456789', text:'晚到的匹配评论', reply_comment_total:0,
    user:{uid:'target-uid', sec_uid:'MS4wLjABAAAAtarget123'},
  }]});
  await handling;
  assert.equal(scanner.ledger.records.size, 0);
  assert.equal(scanner.identity, null);
  assert.equal(JSON.stringify(job), stoppedState);
  assert.equal(published.length, publications);
});

test('concurrent runScan calls never run multiple scan loops at once', async () => {
  const {scanner} = fixture();
  const firstLoop = deferred();
  let loops = 0, active = 0, peak = 0;
  scanner._scanLoop = async () => {
    loops++;
    active++;
    peak = Math.max(peak, active);
    if (loops === 1) await firstLoop.promise;
    else await Promise.resolve();
    active--;
  };
  const scans = [scanner.runScan(), scanner.runScan(), scanner.runScan()];
  await Promise.resolve();
  assert.equal(loops, 1);
  assert.equal(peak, 1);
  firstLoop.resolve();
  await Promise.all(scans);
  assert.equal(active, 0);
  assert.equal(peak, 1);
  assert.equal(scanner.runningPromise, null);
});

test('stopping an active scan prevents queued runScan calls from restarting it', async () => {
  const {scanner, job} = fixture();
  const activeLoop = deferred();
  let loops = 0;
  scanner._scanLoop = async () => { loops++; await activeLoop.promise; };
  const first = scanner.runScan();
  const queued = scanner.runScan();
  await Promise.resolve();
  assert.equal(loops, 1);
  await scanner.stop();
  activeLoop.resolve();
  await Promise.all([first, queued]);
  assert.equal(loops, 1);
  assert.equal(job.status, 'finished');
  assert.equal(scanner.runningPromise, null);
});
