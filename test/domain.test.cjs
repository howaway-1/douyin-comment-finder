'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVideoInput, parseTargetInput, ScanLedger } = require('../lib/domain.cjs');

const video = '7411111111111111111';
const sec = 'MS4wLjABAAAA_target_account';
const target = { kind: 'sec_uid', value: sec };
const other = { sec_uid: 'MS4wLjABAAAA_someone_else', uid: '22222' };
const own = { sec_uid: sec, uid: '11111', unique_id: 'target.handle' };
const main = cursor => `https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=${video}&cursor=${cursor}`;
const replies = (parent, cursor) => `https://www.douyin.com/aweme/v1/web/comment/list/reply/?item_id=${video}&comment_id=${parent}&cursor=${cursor}`;
const comment = (cid, user = other, extra = {}) => ({ cid, aweme_id: video, text: `comment ${cid}`, user, create_time: 1720000000, reply_comment_total: 0, ...extra });
const page = (comments, has_more = false, cursor = '0', extra = {}) => ({ status_code: 0, comments, has_more, cursor, ...extra });

test('video inputs accept share text, canonicalize modal links and defer valid short links', () => {
  assert.deepEqual(parseVideoInput(`复制打开抖音 https://www.douyin.com/video/${video}?from=test 视频`), { url: `https://www.douyin.com/video/${video}`, videoId: video });
  assert.equal(parseVideoInput(`https://www.douyin.com/user/${sec}?modal_id=${video}`).videoId, video);
  assert.deepEqual(parseVideoInput('https://v.douyin.com/abcD123/'), { url: 'https://v.douyin.com/abcD123/', videoId: null });
});

test('photo-note links preserve their route while resolving the same work ID', () => {
  const noteId = '7411111111111111112';
  for (const input of [
    `https://www.douyin.com/note/${noteId}`,
    `https://douyin.com/note/${noteId}/?from=share#comments`,
    `复制打开抖音 https://www.douyin.com/note/${noteId}?from=share 图文作品`,
  ]) {
    assert.deepEqual(parseVideoInput(input), { url: `https://www.douyin.com/note/${noteId}`, videoId: noteId });
  }
  assert.deepEqual(parseVideoInput(`https://www.douyin.com/user/${sec}?modal_id=${noteId}`), {
    url: `https://www.douyin.com/video/${noteId}`, videoId: noteId,
  });
});

test('URLs reject external hosts, credentials, local addresses, HTTP and non-video pages', () => {
  for (const url of [
    `https://www.douyin.com.evil.test/video/${video}`,
    `https://user:secret@www.douyin.com/video/${video}`,
    `https://127.0.0.1/video/${video}`,
    `http://www.douyin.com/video/${video}`,
    `https://www.douyin.com:444/video/${video}`,
    `https://www.douyin.com/user/${sec}`,
    'https://v.douyin.com/path/another',
    'https://www.douyin.com/note/not-a-number',
    `https://www.douyin.com/note/${video}/another`,
  ]) assert.throws(() => parseVideoInput(url));
});

test('target inputs distinguish account handles from stable profile IDs', () => {
  assert.deepEqual(parseTargetInput('抖音号：@target.handle'), { kind: 'handle', value: 'target.handle' });
  assert.equal(parseTargetInput(sec).kind, 'sec_uid');
  assert.equal(parseTargetInput(`https://www.douyin.com/user/${sec}?from=test`).value, sec);
  assert.throws(() => parseTargetInput('https://v.douyin.com/example/'));
  assert.throws(() => parseTargetInput('https://example.com/user/target'));
  assert.throws(() => parseTargetInput('名字 有空格'));
});

test('a target reply is found below a parent written by someone else', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1 })]));
  assert.equal(ledger.snapshot().verdict, 'incomplete');
  // Reply records may omit aweme_id; the request binds them to the video.
  ledger.ingest(replies('p1', '0'), page([{ cid: 'r1', text: '确实不错', user: own, create_time: 1720000001 }], false, '0', { total: 1 }));
  const result = ledger.snapshot();
  assert.equal(result.verdict, 'found');
  assert.equal(result.complete, true);
  assert.deepEqual(result.matches.map(m => [m.id, m.parentId, m.text]), [['r1', 'p1', '确实不错']]);
  assert.equal(result.stats.replyThreadsDone, 1);
});

test('out-of-order responses, successful retries, and duplicate pages reconstruct one chain', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('20'), page([comment('p2')], false));
  assert.equal(ledger.snapshot().complete, false);
  ledger.ingest(main('0'), { status_code: 4, status_msg: 'please retry' });
  ledger.ingest(main('0'), page([comment('p1')], true, '20'));
  ledger.ingest(main('0'), page([comment('p1')], true, '20'));
  const result = ledger.snapshot();
  assert.equal(result.verdict, 'not_found');
  assert.equal(result.stats.comments, 2);
  assert.equal(result.stats.pages, 2);
});

test('an empty, terminal first page is a complete current-visible negative result', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([], false, '0', { total: 0 }));
  assert.equal(ledger.snapshot().verdict, 'not_found');
  assert.equal(ledger.snapshot().complete, true);
});

test('missing author identifiers never become a negative result', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([comment('p1', { nickname: 'someone' })]));
  assert.equal(ledger.snapshot().verdict, 'incomplete');
  assert.equal(ledger.snapshot().stats.unresolved, 1);
});

test('UID and sec_uid namespaces are not interchangeable', () => {
  const ledger = new ScanLedger(video, { kind: 'sec_uid', value: '12345678' });
  ledger.ingest(main('0'), page([comment('p1', { uid: '12345678' })]));
  assert.equal(ledger.snapshot().matches.length, 0);
  assert.equal(ledger.snapshot().verdict, 'incomplete');
});

test('account-handle matches resolve stable identity and retrospectively match earlier records', () => {
  const ledger = new ScanLedger(video, { kind: 'handle', value: 'target.handle' });
  ledger.ingest(main('0'), page([
    comment('p1', { uid: '11111' }),
    comment('p2', own),
    comment('p3', { uid: '22222' }),
  ]));
  const result = ledger.snapshot();
  assert.equal(result.complete, true);
  assert.deepEqual(result.matches.map(m => m.id), ['p1', 'p2']);
  assert.equal(result.matches[0].matchBy, 'uid');
  assert.equal(Object.hasOwn(result.matches[0], 'user'), false);
});

test('an unresolved account handle cannot support not_found; explicit verified mapping can', () => {
  const ledger = new ScanLedger(video, { kind: 'handle', value: 'target.handle' });
  ledger.ingest(main('0'), page([comment('p1', { uid: '22222', unique_id: 'other.handle' })]));
  assert.equal(ledger.snapshot().verdict, 'incomplete');
  assert.throws(() => ledger.setTargetIdentity({ uid: '11111', unique_id: 'different.handle' }));
  ledger.setTargetIdentity(own);
  assert.equal(ledger.snapshot().verdict, 'not_found');
});

test('missing intermediate pages, stalled cursors, and empty continuation pages remain incomplete', () => {
  const missing = new ScanLedger(video, target);
  missing.ingest(main('0'), page([comment('p1')], true, '20'));
  missing.ingest(main('40'), page([comment('p3')], false));
  assert.equal(missing.snapshot().verdict, 'incomplete');
  const stalled = new ScanLedger(video, target);
  stalled.ingest(main('0'), page([comment('p1')], true, '0'));
  assert.equal(stalled.snapshot().complete, false);
  const empty = new ScanLedger(video, target);
  empty.ingest(main('0'), page([], true, '20'));
  empty.ingest(main('20'), page([], false));
  assert.equal(empty.snapshot().complete, false);
});

test('declared reply counts, missing reply metadata, and reply pagination gaps are checked', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 2 })]));
  ledger.ingest(replies('p1', '0'), page([comment('r1')], false));
  assert.equal(ledger.snapshot().verdict, 'incomplete');
  const absent = new ScanLedger(video, target);
  absent.ingest(main('0'), page([{ cid: 'p1', user: other }]));
  assert.equal(absent.snapshot().complete, false);
  const gap = new ScanLedger(video, target);
  gap.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1 })]));
  gap.ingest(replies('p1', '20'), page([comment('r1')], false));
  assert.equal(gap.snapshot().complete, false);
});

test('embedded reply previews can find the target but do not prove pagination complete', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1, reply_comment: [comment('r1', own)] })]));
  assert.equal(ledger.snapshot().verdict, 'found');
  assert.equal(ledger.snapshot().complete, false);
  ledger.ingest(replies('p1', '0'), page([comment('r1', own)], false));
  assert.equal(ledger.snapshot().complete, true);
  assert.equal(ledger.snapshot().matches.length, 1);
});

test('other videos and unrelated endpoints do not leak comments into results', () => {
  const ledger = new ScanLedger(video, target);
  assert.equal(ledger.ingest(main('0').replace(video, '99999999'), page([comment('p1', own)])).accepted, false);
  assert.equal(ledger.ingest('https://www.douyin.com/not-comment', page([comment('p1', own)])).accepted, false);
  assert.equal(ledger.snapshot().matches.length, 0);
  assert.equal(ledger.snapshot().stats.comments, 0);
});

test('known matches remain found when a failure prevents proving full coverage', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([comment('p1', own)], true, '20'));
  ledger.markIssue('用户取消了后续读取');
  assert.equal(ledger.snapshot().verdict, 'found');
  assert.equal(ledger.snapshot().complete, false);
  assert.match(ledger.snapshot().reason, /不完整/);
});

test('conflicting pagination and contradictory stable identities prevent negative certainty', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([comment('p1')], false));
  ledger.ingest(main('0'), page([comment('p1')], true, '20'));
  ledger.ingest(main('20'), page([comment('p2')], false));
  assert.equal(ledger.snapshot().verdict, 'incomplete');
  const conflicting = new ScanLedger(video, { kind: 'handle', value: 'target.handle' });
  conflicting.setTargetIdentity(own);
  conflicting.ingest(main('0'), page([comment('p1', { uid: own.uid, sec_uid: other.sec_uid })]));
  assert.equal(conflicting.snapshot().verdict, 'incomplete');
  assert.equal(conflicting.snapshot().matches.length, 0);
});

test('a terminal page without explicit success status does not prove no target comments', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), { comments: [], has_more: false, cursor: 0 });
  assert.equal(ledger.snapshot().verdict, 'incomplete');
  assert.match(ledger.snapshot().diagnostics.join(' '), /成功状态/);
});

test('comments outside the connected pagination chain cannot support a complete negative', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([comment('p1')], false));
  ledger.ingest(main('99'), page([comment('p2')], false));
  assert.equal(ledger.snapshot().verdict, 'incomplete');
  assert.equal(ledger.snapshot().stats.mainComplete, false);
});

test('a reply preview absent from the terminal reply response is inconsistent, not complete', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1, reply_comment: [comment('r1', other)] })]));
  ledger.ingest(replies('p1', '0'), page([], false));
  assert.equal(ledger.snapshot().verdict, 'incomplete');
  assert.match(ledger.snapshot().diagnostics.join(' '), /预览与回复分页/);
});

test('a changing total cannot be explained away by different counting conventions', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1 })], true, '20', { total: 3 }));
  ledger.ingest(main('20'), page([comment('p2')], false, '0', { total: 2 }));
  ledger.ingest(replies('p1', '0'), page([comment('r1')], false));
  assert.equal(ledger.snapshot().verdict, 'incomplete');
  assert.match(ledger.snapshot().diagnostics.join(' '), /总数在扫描期间/);
});

test('a verified sec_uid observed on a comment also resolves its uid alias', () => {
  const ledger = new ScanLedger(video, target);
  ledger.ingest(main('0'), page([comment('p1', { uid: own.uid }), comment('p2', own)]));
  assert.equal(ledger.snapshot().complete, true);
  assert.deepEqual(ledger.snapshot().matches.map(m => m.id), ['p1', 'p2']);
});

test('malformed reply counts are unknown rather than coerced to zero', () => {
  for (const value of [false, [], {}, '']) {
    const ledger = new ScanLedger(video, target);
    ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: value })]));
    assert.equal(ledger.snapshot().verdict, 'incomplete');
  }
});

test('adaptive boundary includes replies at 100 comments and skips expansion at 101', () => {
  for (const [total, expectedScope] of [[100, 'all'], [101, 'main_only']]) {
    const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
    ledger.ingest(main('0'), page(Array.from({ length: total }, (_, i) => comment(`p${i}`)), false, '0', { total }));
    const result = ledger.snapshot();
    assert.equal(result.coverage.scope, expectedScope);
    assert.equal(result.complete, true);
    assert.equal(result.coverage.scopeComplete, true);
    assert.equal(result.coverage.allCommentsComplete, expectedScope === 'all');
    assert.equal(result.coverage.repliesSkipped, expectedScope === 'main_only');
  }
});

test('unknown totals defer reply expansion until a completed main chain supplies known counts', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  assert.equal(ledger.scope().mode, 'pending');
  assert.equal(ledger.scope().observedTotal, null);
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1 })], true, '20'));
  assert.equal(ledger.scope().mode, 'pending');
  ledger.ingest(main('20'), page([comment('p2')], false));
  assert.equal(ledger.scope().mode, 'all');
  assert.equal(ledger.scope().observedTotal, 3);
  assert.equal(ledger.snapshot().complete, false);
  ledger.ingest(replies('p1', '0'), page([comment('r1')], false));
  assert.equal(ledger.snapshot().complete, true);
});

test('a terminal main page with unknown reply counts keeps an adaptive scope pending', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([{ cid: 'p1', user: other }]));
  assert.equal(ledger.scope().mode, 'pending');
  assert.equal(ledger.snapshot().complete, false);
});

test('known reply counts contribute to the threshold even when total counts only parents', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 100 })], false, '0', { total: 1 }));
  assert.equal(ledger.scope().mode, 'main_only');
  assert.equal(ledger.scope().observedTotal, 101);
  assert.equal(ledger.snapshot().complete, true);
  assert.equal(ledger.snapshot().stats.replyThreadsDone, 0);
});

test('an observed growing total upgrades to main-only and never returns to all', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([comment('p1')], true, '20', { total: 100 }));
  assert.equal(ledger.scope().mode, 'all');
  ledger.ingest(main('20'), page([comment('p2')], true, '40', { total: 101 }));
  assert.equal(ledger.scope().mode, 'main_only');
  ledger.ingest(main('40'), page([comment('p3')], false, '0', { total: 1 }));
  assert.equal(ledger.scope().mode, 'main_only');
  assert.equal(ledger.scope().observedTotal, 101);
  assert.equal(ledger.snapshot().complete, false);
  assert.match(ledger.snapshot().diagnostics.join(' '), /总数在扫描期间/);
});

test('main-only negative results explicitly exclude replies and need no reply pagination', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 100 })], false, '0', { total: 101 }));
  const result = ledger.snapshot();
  assert.equal(result.verdict, 'not_found');
  assert.equal(result.complete, true);
  assert.equal(result.coverage.allCommentsComplete, false);
  assert.match(result.reason, /一级评论/);
  assert.match(result.reason, /未检索楼中楼回复/);
  assert.match(result.reason, /不能据此判断/);
  assert.deepEqual(result.diagnostics, []);
});

test('main-only scans preserve already delivered reply matches without awaiting further replies', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([comment('p1', other, {
    reply_comment_total: 100, reply_comment: [comment('r1', own), comment('r2', {})],
  })], false, '0', { total: 101 }));
  ledger.ingest(replies('p1', '0'), { status_code: 403 });
  const result = ledger.snapshot();
  assert.equal(result.complete, true);
  assert.equal(result.verdict, 'found');
  assert.deepEqual(result.matches.map(item => item.id), ['r1']);
  assert.equal(result.stats.unresolved, 1);
  assert.equal(result.stats.unresolvedInScope, 0);
});

test('main-only scans still require all main pages and resolvable main authors', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([comment('p1', {}, { reply_comment_total: 100 })], true, '20', { total: 102 }));
  assert.equal(ledger.snapshot().complete, false);
  ledger.ingest(main('20'), page([comment('p2')], false, '0', { total: 102 }));
  assert.equal(ledger.snapshot().stats.mainComplete, true);
  assert.equal(ledger.snapshot().complete, false);
  assert.equal(ledger.snapshot().stats.unresolvedInScope, 1);
});

test('observed records alone can trigger main-only mode when no total is supplied', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page(Array.from({ length: 101 }, (_, i) => comment(`p${i}`)), false));
  assert.equal(ledger.scope().mode, 'main_only');
  assert.equal(ledger.snapshot().complete, true);
});

test('adaptive small scans accept a complete inline reply list from one successful main response', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([
    comment('p1', other, { reply_comment_total: 1, reply_comment: [comment('r1', own)] }),
    comment('p2'),
  ], false, '0', { total: 3 }));
  const result = ledger.snapshot();
  assert.equal(result.complete, true);
  assert.equal(result.coverage.allCommentsComplete, true);
  assert.equal(result.coverage.inlineReplyThreads, 1);
  assert.equal(result.stats.replyThreadsDone, 1);
  assert.deepEqual(result.matches.map(item => item.id), ['r1']);
});

test('duplicate, partial, and absent-count inline replies cannot prove all replies were read', () => {
  for (const extra of [
    { reply_comment_total: 2, reply_comment: [comment('r1'), comment('r1')] },
    { reply_comment_total: 2, reply_comment: [comment('r1')] },
    { reply_comment_total: undefined, reply_comment: [comment('r1')] },
    { reply_comment_total: 1, reply_comment: [{ text: 'no id', user: other }] },
  ]) {
    const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
    ledger.ingest(main('0'), page([comment('p1', other, extra)], false, '0', { total: 3 }));
    assert.equal(ledger.snapshot().complete, false);
    assert.equal(ledger.snapshot().coverage.inlineReplyThreads, 0);
  }
});

test('separate partial inline lists cannot be combined into complete inline evidence', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  for (const cid of ['r1', 'r2']) ledger.ingest(main('0'), page([
    comment('p1', other, { reply_comment_total: 2, reply_comment: [comment(cid)] }),
  ], false, '0', { total: 3 }));
  assert.equal(ledger.snapshot().stats.replies, 2);
  assert.equal(ledger.snapshot().complete, false);
  assert.equal(ledger.snapshot().coverage.inlineReplyThreads, 0);
});

test('changing reply counts invalidate complete inline evidence', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1, reply_comment: [comment('r1')] })]));
  assert.equal(ledger.snapshot().complete, true);
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 2, reply_comment: [comment('r1'), comment('r2')] })]));
  assert.equal(ledger.snapshot().complete, false);
  assert.match(ledger.snapshot().diagnostics.join(' '), /回复数量在扫描期间变化/);
});

test('inline replies cannot override failed or incomplete explicit reply pagination', () => {
  for (const body of [{ status_code: 403 }, page([comment('r1')], true, '20')]) {
    const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
    ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1, reply_comment: [comment('r1')] })], false, '0', { total: 2 }));
    ledger.ingest(replies('p1', '0'), body);
    assert.equal(ledger.snapshot().complete, false);
    assert.equal(ledger.snapshot().coverage.inlineReplyThreads, 0);
  }
});

test('inline replies do not override main pagination conflicts or unresolved reply authors', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1, reply_comment: [comment('r1', {})] })], false, '0', { total: 2 }));
  assert.equal(ledger.snapshot().complete, false);
  const conflict = new ScanLedger(video, target, { replyThreshold: 100 });
  conflict.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1, reply_comment: [comment('r1')] })], false, '0', { total: 2 }));
  conflict.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1, reply_comment: [comment('r1')] })], true, '20', { total: 2 }));
  assert.equal(conflict.snapshot().complete, false);
});

test('retrying without total metadata cannot erase a contradictory previously declared total', () => {
  for (const options of [{}, { replyThreshold: 100 }]) {
    const ledger = new ScanLedger(video, target, options);
    ledger.ingest(main('0'), page([comment('p1')], false, '0', { total: 101 }));
    assert.equal(ledger.snapshot().complete, false);
    ledger.ingest(main('0'), page([comment('p1')], false));
    assert.equal(ledger.snapshot().complete, false);
    assert.match(ledger.snapshot().diagnostics.join(' '), /总数与已读取数量不一致/);
  }
});

test('adaptive empty results finish the complete all-comment scope without reply requests', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([], false, '0', { total: 0 }));
  const result = ledger.snapshot();
  assert.equal(result.verdict, 'not_found');
  assert.equal(result.coverage.scope, 'all');
  assert.equal(result.coverage.observedTotal, 0);
  assert.equal(result.coverage.allCommentsComplete, true);
});

test('all available pages can be exhausted while the reported total still prevents a complete negative', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  const parents = Array.from({ length: 28 }, (_, i) => {
    const children = Array.from({ length: i < 10 ? 2 : 1 }, (_, j) => comment(`r${i}-${j}`));
    return comment(`p${i}`, other, { reply_comment_total: children.length, reply_comment: children });
  });
  ledger.ingest(main('0'), page(parents.slice(0, 20), true, '20', { total: 77 }));
  assert.equal(ledger.snapshot().coverage.pagesExhausted, false);
  ledger.ingest(main('20'), page(parents.slice(20), false, '0', { total: 77 }));
  const result = ledger.snapshot();
  assert.equal(result.stats.comments, 28);
  assert.equal(result.stats.replies, 38);
  assert.equal(result.stats.replyThreadsDone, 28);
  assert.equal(result.coverage.pagesExhausted, true);
  assert.deepEqual(result.coverage.reportedTotals, [77]);
  assert.deepEqual(result.coverage.pendingReplyIds, []);
  assert.equal(result.complete, false);
  assert.equal(result.verdict, 'incomplete');
  assert.match(result.reason, /总数与已读取数量不一致/);
});

test('exhausted pagination and reported totals remain separate from changing aggregate counts', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([comment('p1')], true, '20', { total: 7 }));
  ledger.ingest(main('20'), page([comment('p2')], false, '0', { total: 5 }));
  const result = ledger.snapshot();
  assert.equal(result.coverage.pagesExhausted, true);
  assert.deepEqual(result.coverage.reportedTotals, [5, 7]);
  assert.equal(result.complete, false);
  assert.match(result.diagnostics.join(' '), /总数在扫描期间/);
});

test('unresolved target or comment authors do not require traversing exhausted pages again', () => {
  const unresolvedTarget = new ScanLedger(video, { kind: 'handle', value: 'target.handle' }, { replyThreshold: 100 });
  unresolvedTarget.ingest(main('0'), page([comment('p1')], false, '0', { total: 1 }));
  assert.equal(unresolvedTarget.snapshot().coverage.pagesExhausted, true);
  assert.equal(unresolvedTarget.snapshot().complete, false);
  unresolvedTarget.setTargetIdentity(own);
  assert.equal(unresolvedTarget.snapshot().complete, true);
  const unresolvedAuthor = new ScanLedger(video, target, { replyThreshold: 100 });
  unresolvedAuthor.ingest(main('0'), page([comment('p1', {})], false, '0', { total: 1 }));
  assert.equal(unresolvedAuthor.snapshot().coverage.pagesExhausted, true);
  assert.equal(unresolvedAuthor.snapshot().verdict, 'incomplete');
});

test('pending reply IDs exclude zero-reply, complete inline, and complete paginated threads', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([
    comment('zero'),
    comment('inline', other, { reply_comment_total: 1, reply_comment: [comment('ri')] }),
    comment('paged', other, { reply_comment_total: 1 }),
    comment('missing', other, { reply_comment_total: 2, reply_comment: [comment('rm1')] }),
  ], false, '0', { total: 8 }));
  ledger.ingest(replies('paged', '0'), page([comment('rp')], false, '0', { total: 1 }));
  assert.deepEqual(ledger.snapshot().coverage.pendingReplyIds, ['missing']);
  assert.equal(ledger.snapshot().coverage.pagesExhausted, false);
  ledger.ingest(replies('missing', '0'), page([comment('rm1'), comment('rm2')], false, '0', { total: 2 }));
  assert.deepEqual(ledger.snapshot().coverage.pendingReplyIds, []);
  assert.equal(ledger.snapshot().coverage.pagesExhausted, true);
  assert.equal(ledger.snapshot().complete, true);
});

test('missing reply counts and orphan reply parents cannot exhaust the all-comment scope', () => {
  const unknown = new ScanLedger(video, target, { replyThreshold: 100 });
  unknown.ingest(main('0'), page([comment('p1', other, { reply_comment_total: undefined })], false, '0', { total: 1 }));
  unknown.ingest(replies('p1', '0'), page([]));
  assert.equal(unknown.snapshot().coverage.scope, 'all');
  assert.equal(unknown.snapshot().coverage.pagesExhausted, false);
  assert.deepEqual(unknown.snapshot().coverage.pendingReplyIds, ['p1']);
  const orphan = new ScanLedger(video, target, { replyThreshold: 100 });
  orphan.ingest(main('0'), page([], false, '0', { total: 0 }));
  orphan.ingest(replies('unseen-parent', '0'), page([comment('r1')]));
  assert.equal(orphan.snapshot().coverage.pagesExhausted, false);
  assert.deepEqual(orphan.snapshot().coverage.pendingReplyIds, ['unseen-parent']);
});

test('reply request errors and conflicting main pagination prevent exhaustion', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1, reply_comment: [comment('r1')] })], false, '0', { total: 2 }));
  ledger.ingest(replies('p1', '0'), { status_code: 403 });
  assert.equal(ledger.snapshot().coverage.pagesExhausted, false);
  assert.deepEqual(ledger.snapshot().coverage.pendingReplyIds, ['p1']);
  ledger.ingest(replies('p1', '0'), page([comment('r1')], false, '0', { total: 1 }));
  assert.equal(ledger.snapshot().coverage.pagesExhausted, true);
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1 })], true, '20', { total: 2 }));
  ledger.ingest(main('20'), page([], false, '0', { total: 2 }));
  assert.equal(ledger.snapshot().coverage.pagesExhausted, false);
});

test('main-only exhaustion does not wait for replies outside the selected scope', () => {
  const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
  ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 101 })], false, '0', { total: 102 }));
  assert.equal(ledger.snapshot().coverage.scope, 'main_only');
  assert.equal(ledger.snapshot().coverage.pagesExhausted, true);
  assert.deepEqual(ledger.snapshot().coverage.pendingReplyIds, ['p1']);
  assert.equal(ledger.snapshot().complete, true);
});

test('embedded and panel pagination cannot splice their identical cursors into an early end', () => {
  const ledger=new ScanLedger(video,target,{replyThreshold:100});
  const rows=Array.from({length:32},(_,i)=>{
    const replyCount=i<10 || (i>=28&&i<31)?2:1;
    return comment(`p${i}`,i===28?own:other,{reply_comment_total:replyCount,
      reply_comment:Array.from({length:replyCount},(_,j)=>comment(`r${i}-${j}`))});
  });
  const embedded=cursor=>main(cursor)+'&count=20&item_type=0&cut_version=1';
  const panel=cursor=>main(cursor)+'&count=10&item_type=0&cut_version=1&pc_img_format=webp&insert_ids=';
  ledger.ingest(embedded(20),page(rows.slice(16,28),false,40,{total:77}));
  ledger.ingest(panel(0),page(rows.slice(0,10),true,10,{total:77}));
  ledger.ingest(panel(10),page(rows.slice(10,20),true,20,{total:77}));
  let result=ledger.snapshot();
  assert.equal(result.stats.comments,28);
  assert.equal(result.stats.replies,38);
  assert.equal(result.stats.mainComplete,false);
  assert.equal(result.coverage.pagesExhausted,false);
  ledger.ingest(panel(20),page(rows.slice(20,30),true,30,{total:77}));
  ledger.ingest(panel(30),page(rows.slice(30),false,40,{total:77}));
  result=ledger.snapshot();
  assert.equal(result.stats.comments,32);
  assert.equal(result.stats.replies,45);
  assert.equal(result.stats.pages,4);
  assert.equal(result.complete,true);
  assert.equal(result.matches[0].id,'p28');
  assert.deepEqual(result.diagnostics,[]);
});

test('a changing page size within one list does not create separate pagination streams',()=>{
  const ledger=new ScanLedger(video,target,{replyThreshold:100});
  ledger.ingest(main(0)+'&count=10',page([comment('one')],true,10,{total:2}));
  ledger.ingest(main(10)+'&count=20',page([comment('two')],false,30,{total:2}));
  assert.equal(ledger.mainStreams.size,1);
  assert.equal(ledger.snapshot().complete,true);
});

test('a contradictory zero-total continuation is recoverable and never a pagination end',()=>{
  const ledger=new ScanLedger(video,target,{replyThreshold:100});
  ledger.ingest(main(0),page([comment('one')],true,10,{total:2}));
  const rejected=ledger.ingest(main(10),page([],false,20,{total:0}));
  assert.equal(rejected.accepted,false);
  assert.equal(ledger.snapshot().coverage.pagesExhausted,false);
  assert.equal(ledger.main.pages.has('10'),false);
  ledger.ingest(main(10),page([comment('two',own)],false,20,{total:2}));
  assert.equal(ledger.snapshot().complete,true);
  assert.equal(ledger.snapshot().matches[0].id,'two');
});

test('malformed totals do not prematurely enable reply expansion', () => {
  for (const total of [false, [], {}, '', -1, 1.5]) {
    const ledger = new ScanLedger(video, target, { replyThreshold: 100 });
    ledger.ingest(main('0'), page([comment('p1', other, { reply_comment_total: 1 })], true, '20', { total }));
    assert.equal(ledger.scope().mode, 'pending');
    assert.equal(ledger.snapshot().complete, false);
  }
});
