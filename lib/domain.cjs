'use strict';

const PROFILE_ID = /^[A-Za-z0-9_-]{6,256}$/;
const DIGITS = /^\d+$/;
const HOSTS = new Set(['douyin.com', 'www.douyin.com', 'v.douyin.com']);

function inputUrl(text) {
  const value = String(text ?? '').trim();
  const match = value.match(/https?:\/\/[^\s<>"'，。；！）】]+/i);
  if (!match) throw new Error('请输入完整的 https 抖音链接。');
  let url;
  try { url = new URL(match[0]); } catch { throw new Error('链接格式不正确。'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
    throw new Error('仅接受没有登录凭证的 https 抖音官方链接。');
  }
  url.hash = '';
  return url;
}

function parseVideoInput(text) {
  const url = inputUrl(text);
  if (url.hostname === 'v.douyin.com') {
    if (!/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new Error('抖音短链接格式不正确。');
    return { url: url.href, videoId: null };
  }
  const direct = url.pathname.match(/^\/(video|note)\/(\d+)\/?$/);
  const modal = /^\/user\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && url.searchParams.get('modal_id');
  const videoId = direct?.[2] || (modal && DIGITS.test(modal) ? modal : null);
  if (!videoId) throw new Error('需要具体视频或图文作品链接，或带 modal_id 的主页作品链接。');
  return { url: `https://www.douyin.com/${direct?.[1] || 'video'}/${videoId}`, videoId };
}

function parseTargetInput(text) {
  let value = String(text ?? '').trim();
  if (/https?:\/\//i.test(value)) {
    const url = inputUrl(value);
    const match = url.hostname !== 'v.douyin.com' && url.pathname.match(/^\/user\/([^/]+)\/?$/);
    if (!match || !PROFILE_ID.test(match[1]) || match[1] === 'self') throw new Error('目标账号需要完整用户主页链接，不支持短链或本人主页别名。');
    return { kind: 'sec_uid', value: match[1], url: `https://www.douyin.com/user/${match[1]}` };
  }
  value = value.replace(/^抖音号\s*[:：]?\s*/, '').replace(/^@/, '').trim();
  if (/^MS4w[A-Za-z0-9_-]{8,252}$/.test(value)) return { kind: 'sec_uid', value, url: `https://www.douyin.com/user/${value}` };
  if (!value || value.length > 64 || /[\s\x00-\x1f\x7f/:?#@\\<>]/.test(value)) throw new Error('请输入抖音号或完整用户主页链接，不能输入昵称或其他网站链接。');
  return { kind: 'handle', value };
}

function scalar(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}
function count(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function identityOf(user) {
  if (!user || typeof user !== 'object') return {};
  return Object.fromEntries(['uid', 'sec_uid', 'unique_id', 'short_id'].map(k => [k, scalar(user[k])]).filter(([, v]) => v && v !== '0'));
}
function hasMore(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}
function newChain() { return { pages: new Map(), errors: new Map(), conflicts: new Set() }; }

class ScanLedger {
  constructor(videoId, target, options = {}) {
    if (!DIGITS.test(String(videoId))) throw new Error('videoId 必须是视频数字 ID。');
    this.videoId = String(videoId);
    this.target = typeof target === 'string' ? parseTargetInput(target) : target;
    if (!this.target || !['sec_uid', 'handle'].includes(this.target.kind) || !this.target.value) throw new Error('目标账号格式不正确。');
    this.identity = this.target.kind === 'sec_uid' ? { sec_uid: this.target.value } : {};
    this.identityResolved = this.target.kind === 'sec_uid';
    this.main = newChain();
    this.replyChains = new Map();
    this.records = new Map();
    this.parents = new Map();
    this.issues = new Set();
    this.replyThreshold = options.replyThreshold === undefined ? null : count(options.replyThreshold);
    if (options.replyThreshold !== undefined && this.replyThreshold === null) throw new Error('楼中楼检索阈值必须是非负整数。');
    this.scopeMode = this.replyThreshold === null ? 'all' : 'pending';
    this.observedTotal = null;
  }

  setTargetIdentity(rawIdentity) {
    const incoming = identityOf(rawIdentity);
    const matchesInput = this.target.kind === 'sec_uid'
      ? incoming.sec_uid === this.target.value
      : incoming.unique_id === this.target.value || incoming.short_id === this.target.value;
    if (!matchesInput) throw new Error('用户资料与输入的目标账号不一致，拒绝合并身份。');
    for (const key of ['uid', 'sec_uid']) {
      if (this.identity[key] && incoming[key] && this.identity[key] !== incoming[key]) throw new Error('目标账号的稳定身份标识出现冲突。');
    }
    this.identity = { ...this.identity, ...incoming };
    this.identityResolved = Boolean(this.identity.uid || this.identity.sec_uid);
    return { ...this.identity };
  }

  markIssue(reason) {
    if (reason) this.issues.add(String(reason));
  }

  _record(raw, parentId, chain) {
    if (!raw || typeof raw !== 'object') { chain.conflicts.add('评论记录格式异常'); return; }
    const id = scalar(raw.cid);
    const awemeId = scalar(raw.aweme_id);
    if (awemeId && awemeId !== this.videoId) { chain.conflicts.add('响应包含其他视频的评论'); return; }
    if (!id) { chain.conflicts.add('存在缺少评论 ID 的记录'); return; }
    const user = identityOf(raw.user);
    if ((this.target.kind === 'handle' && (user.unique_id === this.target.value || user.short_id === this.target.value)) ||
        (this.target.kind === 'sec_uid' && user.sec_uid === this.target.value)) {
      try { this.setTargetIdentity(user); } catch { this.issues.add('同一抖音号出现不同稳定身份标识，无法确认账号'); }
    }
    const old = this.records.get(id);
    if (old && old.parentId !== parentId) { chain.conflicts.add('同一评论 ID 出现在不同回复位置'); return; }
    const mergedUser = { ...(old?.user || {}), ...user };
    for (const key of ['uid', 'sec_uid']) {
      if (old?.user[key] && user[key] && old.user[key] !== user[key]) chain.conflicts.add('同一评论的作者身份出现冲突');
    }
    this.records.set(id, {
      id, text: typeof raw.text === 'string' ? raw.text : (old?.text || ''),
      time: count(raw.create_time) ?? old?.time ?? null,
      videoId: this.videoId, parentId, user: mergedUser,
    });
    if (!parentId) {
      const expected = count(raw.reply_comment_total);
      const existing = this.parents.get(id);
      if (existing && existing.expected !== null && expected !== null && existing.expected !== expected) chain.conflicts.add('父评论声明的回复数量在扫描期间变化');
      const inlineIds = new Set();
      if (Array.isArray(raw.reply_comment)) for (const reply of raw.reply_comment) {
        const replyId = this._record(reply, id, chain);
        if (replyId) inlineIds.add(replyId);
      }
      // A single successful response may include every reply inline. Only use
      // that evidence when its explicit count exactly matches unique valid IDs;
      // never assemble a "complete preview" from partial responses over time.
      const inlineComplete = expected !== null && expected > 0 && Array.isArray(raw.reply_comment) &&
        raw.reply_comment.length === expected && inlineIds.size === expected;
      this.parents.set(id, { expected: expected ?? existing?.expected ?? null, inlineIds: inlineComplete ? inlineIds : null });
    }
    return id;
  }

  ingest(requestUrl, rawBody) {
    let url;
    try { url = new URL(requestUrl); } catch { return { accepted: false, reason: 'invalid_url' }; }
    const kind = url.pathname === '/aweme/v1/web/comment/list/' ? 'main' : url.pathname === '/aweme/v1/web/comment/list/reply/' ? 'reply' : null;
    if (!kind || !['www.douyin.com', 'douyin.com'].includes(url.hostname) || url.protocol !== 'https:') return { accepted: false, reason: 'irrelevant_endpoint' };
    const requestVideo = url.searchParams.get(kind === 'main' ? 'aweme_id' : 'item_id');
    if (requestVideo !== this.videoId) return { accepted: false, reason: 'other_video' };
    const parentId = kind === 'reply' ? scalar(url.searchParams.get('comment_id')) : null;
    if (kind === 'reply' && !parentId) { this.markIssue('回复请求缺少父评论 ID'); return { accepted: false, reason: 'missing_parent' }; }
    if (kind === 'reply' && !this.replyChains.has(parentId)) this.replyChains.set(parentId, newChain());
    const chain = kind === 'main' ? this.main : this.replyChains.get(parentId);
    const cursor = scalar(url.searchParams.get('cursor')) || '0';
    const fail = reason => { chain.errors.set(cursor, reason); return { accepted: false, reason }; };
    let body = rawBody;
    try { if (typeof body === 'string') body = JSON.parse(body); } catch { return fail('评论响应不是有效 JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('评论响应结构异常');
    if (body.status_code === undefined) return fail('评论响应缺少成功状态标记');
    if (String(body.status_code) !== '0') return fail('评论接口返回非成功状态');
    if (scalar(body.aweme_id) && scalar(body.aweme_id) !== this.videoId) return fail('响应视频 ID 与请求不一致');
    const more = hasMore(body.has_more);
    if (more === null) return fail('响应缺少明确的分页结束标记');
    if (body.comments !== null && !Array.isArray(body.comments)) return fail('响应缺少评论列表');
    const comments = body.comments || [];
    const next = scalar(body.cursor);
    if (more && !next) return fail('还有下一页但缺少分页游标');
    const ids = new Set();
    for (const comment of comments) {
      const id = this._record(comment, parentId, chain);
      if (id) ids.add(id);
    }
    const page = { more, next, ids, total: count(body.total), empty: comments.length === 0 };
    const existing = chain.pages.get(cursor);
    if (existing) {
      if (existing.more !== more || (more && existing.next !== next) || (existing.total !== null && page.total !== null && existing.total !== page.total)) chain.conflicts.add('同一分页游标返回了冲突的分页信息');
      // Missing metadata in a retry cannot erase a total already observed for
      // the same page and thereby turn an inconsistent scan into a complete one.
      if (page.total === null) page.total = existing.total;
      // A successful retry may return a fuller page. Preserve every observed ID.
      for (const id of existing.ids) ids.add(id);
      page.empty = ids.size === 0;
    }
    chain.pages.set(cursor, page);
    chain.errors.delete(cursor);
    this.scope();
    return { accepted: true, kind, cursor, parentId };
  }

  scope() {
    const totals = [...this.main.pages.values()].map(page => page.total).filter(total => total !== null);
    const children = new Map();
    let mainCount = 0;
    for (const record of this.records.values()) {
      if (!record.parentId) mainCount++;
      else children.set(record.parentId, (children.get(record.parentId) || 0) + 1);
    }
    let knownReplyCount = 0;
    for (const [id, parent] of this.parents) {
      knownReplyCount += Math.max(parent.expected ?? 0, children.get(id) || 0);
      children.delete(id);
    }
    for (const size of children.values()) knownReplyCount += size;
    if (this.main.pages.size) {
      this.observedTotal = Math.max(this.observedTotal ?? 0, mainCount + knownReplyCount, ...totals);
      if (this.replyThreshold !== null && this.scopeMode !== 'main_only') {
        if (this.observedTotal > this.replyThreshold) this.scopeMode = 'main_only';
        else if (totals.length || (this._coverage(this.main).complete && [...this.parents.values()].every(parent => parent.expected !== null))) this.scopeMode = 'all';
      }
    }
    const reason = this.scopeMode === 'pending'
      ? '正在读取一级评论，评论总量明确后自动确定是否展开楼中楼。'
      : this.scopeMode === 'main_only'
        ? `已知评论总量 ${this.observedTotal} 条，超过 ${this.replyThreshold} 条，本次只检索一级评论。`
        : this.replyThreshold === null
          ? '检索一级评论和楼中楼回复。'
          : `已知评论总量 ${this.observedTotal} 条，不超过 ${this.replyThreshold} 条，将检索一级评论和楼中楼回复。`;
    return { mode: this.scopeMode, replyThreshold: this.replyThreshold, observedTotal: this.observedTotal, reason };
  }

  _coverage(chain) {
    const issues = [...chain.conflicts, ...chain.errors.values()];
    const visited = new Set();
    const ids = new Set();
    let cursor = '0';
    let terminal = false;
    while (true) {
      if (visited.has(cursor)) { issues.push('分页游标形成循环'); break; }
      const page = chain.pages.get(cursor);
      if (!page) { issues.push(cursor === '0' ? '尚未读取第一页' : '分页链缺少中间页'); break; }
      visited.add(cursor);
      for (const id of page.ids) ids.add(id);
      if (!page.more) { terminal = true; break; }
      if (page.empty) { issues.push('空页仍声明存在下一页'); break; }
      if (page.next === cursor) { issues.push('分页游标没有前进'); break; }
      cursor = page.next;
    }
    if (visited.size < chain.pages.size) issues.push('存在未接入当前分页链的页面');
    return { complete: terminal && issues.length === 0, issues, ids, pages: chain.pages.size };
  }

  _match(user) {
    const stable = ['uid', 'sec_uid'].filter(k => this.identity[k] && user[k]);
    const stableMatches = stable.filter(k => this.identity[k] === user[k]);
    if (stableMatches.length && stableMatches.length !== stable.length) return { unresolved: true };
    if (stableMatches.length) return { matched: true, matchBy: stableMatches[0] };
    if (stable.length) {
      if (this.target.kind === 'handle' && (user.unique_id === this.target.value || user.short_id === this.target.value)) return { unresolved: true };
      return { matched: false };
    }
    if (this.target.kind === 'handle') {
      const handles = ['unique_id', 'short_id'].filter(k => user[k]);
      const matchBy = handles.find(k => user[k] === this.target.value);
      if (matchBy) return { matched: true, matchBy };
      if (handles.length) return { matched: false };
    }
    return { unresolved: true };
  }

  snapshot() {
    const scope = this.scope();
    const mainOnly = scope.mode === 'main_only';
    const main = this._coverage(this.main);
    const diagnostics = [...this.issues, ...main.issues.map(x => `一级评论：${x}`)];
    const replyDiagnostics = [];
    const matches = [];
    const childrenByParent = new Map();
    let unresolved = 0;
    let unresolvedInScope = 0;
    let comments = 0;
    let replies = 0;
    for (const record of this.records.values()) {
      record.parentId ? replies++ : comments++;
      if (record.parentId) {
        if (!childrenByParent.has(record.parentId)) childrenByParent.set(record.parentId, new Set());
        childrenByParent.get(record.parentId).add(record.id);
      }
      const result = this._match(record.user);
      if (result.unresolved) {
        unresolved++;
        if (!mainOnly || !record.parentId) unresolvedInScope++;
      }
      if (result.matched) matches.push({
        id: record.id, text: record.text, time: record.time, videoId: record.videoId,
        parentId: record.parentId,
        authorUrl: record.user.sec_uid ? `https://www.douyin.com/user/${record.user.sec_uid}` : null,
        matchBy: result.matchBy,
      });
    }
    let replyThreadsDone = 0;
    let replyThreadsTotal = 0;
    let inlineReplyThreads = 0;
    for (const [id, parent] of this.parents) {
      const children = childrenByParent.get(id)?.size || 0;
      const chain = this.replyChains.get(id);
      if (parent.expected === null) replyDiagnostics.push(`评论 ${id} 缺少回复总数`);
      if (parent.expected === 0 && children === 0 && !chain) continue;
      replyThreadsTotal++;
      if (this.replyThreshold !== null && scope.mode === 'all' && !chain && parent.inlineIds?.size === parent.expected && children === parent.expected) {
        replyThreadsDone++;
        inlineReplyThreads++;
        continue;
      }
      const coverage = this._coverage(chain || newChain());
      let valid = coverage.complete;
      for (const reason of coverage.issues) replyDiagnostics.push(`评论 ${id} 的回复：${reason}`);
      if (parent.expected !== null && children !== parent.expected) { valid = false; replyDiagnostics.push(`评论 ${id} 声明 ${parent.expected} 条回复，实际读取 ${children} 条`); }
      if (coverage.complete && coverage.ids.size !== children) { valid = false; replyDiagnostics.push(`评论 ${id} 的回复预览与回复分页记录不一致`); }
      for (const page of chain?.pages.values() || []) {
        if (page.total !== null && page.total !== children) { valid = false; replyDiagnostics.push(`评论 ${id} 的回复接口总数与读取数量不一致`); }
      }
      if (valid && parent.expected !== null) replyThreadsDone++;
    }
    for (const id of this.replyChains.keys()) if (!this.parents.has(id)) replyDiagnostics.push(`读取了父评论 ${id} 尚不可见的回复，无法确认完整性`);
    if (!mainOnly) diagnostics.push(...replyDiagnostics);
    // Douyin surfaces use total either for top-level comments or for all comments.
    // Accept either convention, but never a total that cannot describe what was read.
    const mainTotals = new Set();
    const expectedRepliesKnown = [...this.parents.values()].every(parent => parent.expected !== null);
    const expectedReplies = expectedRepliesKnown ? [...this.parents.values()].reduce((sum, parent) => sum + parent.expected, 0) : null;
    for (const page of this.main.pages.values()) {
      if (page.total !== null) mainTotals.add(page.total);
      if (page.total !== null && main.complete) {
        // A main-only scan has deliberately not downloaded all replies. Validate
        // against declared reply counts where available, rather than fetched ones.
        const consistent = mainOnly
          ? page.total === comments || (expectedReplies === null ? page.total >= comments : page.total === comments + expectedReplies)
          : page.total === comments || page.total === comments + replies;
        if (!consistent) diagnostics.push('视频评论总数与已读取数量不一致');
      }
    }
    if (mainTotals.size > 1) diagnostics.push('视频评论总数在扫描期间发生变化');
    if (!this.identityResolved) diagnostics.push('尚未将目标抖音号核验为稳定账号 ID');
    if (unresolvedInScope) diagnostics.push(`${unresolvedInScope} 条${mainOnly ? '一级' : ''}评论缺少可核对的作者标识或标识冲突`);
    if (scope.mode === 'pending') diagnostics.push(scope.reason);
    const uniqueDiagnostics = [...new Set(diagnostics)];
    const complete = scope.mode !== 'pending' && main.complete && (mainOnly || replyThreadsDone === replyThreadsTotal) && uniqueDiagnostics.length === 0;
    const verdict = matches.length ? 'found' : complete ? 'not_found' : 'incomplete';
    const reason = verdict === 'found'
      ? mainOnly
        ? `找到 ${matches.length} 条目标账号评论；${complete ? '一级评论范围已读取完成' : '一级评论范围仍不完整'}，本次未展开楼中楼回复。`
        : `找到 ${matches.length} 条目标账号评论${complete ? '，已完整读取接口当前返回的评论范围。' : '；当前扫描仍不完整。'}`
      : verdict === 'not_found'
        ? mainOnly
          ? '在已完整读取的一级评论中，未发现目标账号评论；本次未检索楼中楼回复，不能据此判断该作品下没有目标账号的回复。'
          : '在已完整读取的该视频当前可见评论及回复中，未发现目标账号评论。'
        : (uniqueDiagnostics[0] || '当前读取尚未完成，不能判断目标账号没有评论。');
    matches.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.id.localeCompare(b.id));
    return {
      verdict, complete, reason, videoId: this.videoId, target: { ...this.target }, matches,
      coverage: { scope: scope.mode, scopeComplete: complete, allCommentsComplete: !mainOnly && complete, replyThreshold: scope.replyThreshold, observedTotal: scope.observedTotal, repliesSkipped: mainOnly, expectedReplies, observedReplies: replies, inlineReplyThreads },
      stats: { comments, replies, unresolved, unresolvedInScope, pages: this.main.pages.size + [...this.replyChains.values()].reduce((n, c) => n + c.pages.size, 0), mainComplete: main.complete, replyThreadsDone, replyThreadsTotal },
      diagnostics: uniqueDiagnostics,
    };
  }
}

module.exports = { parseVideoInput, parseTargetInput, ScanLedger };
