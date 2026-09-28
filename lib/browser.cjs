'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {loadPlaywright} = require('./runtime.cjs');
const {describeLaunchError} = require('./launch-errors.cjs');
const {parseVideoInput, parseTargetInput, ScanLedger} = require('./domain.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function isDouyin(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com')); } catch { return false; }
}
function identityMatches(target, user) {
  if (!user || typeof user !== 'object') return false;
  return target.kind === 'sec_uid' ? String(user.sec_uid || '') === target.value :
    [user.unique_id, user.short_id].some(x => x != null && String(x) === target.value);
}
function findIdentity(body, target, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 9) return null;
  if (identityMatches(target, body) && (body.uid || body.sec_uid)) {
    return Object.fromEntries(['uid','sec_uid','unique_id','short_id'].filter(k => typeof body[k] === 'string' || (typeof body[k] === 'number' && Number.isSafeInteger(body[k]))).map(k => [k, String(body[k])]));
  }
  for (const value of Object.values(body)) {
    if (value && typeof value === 'object') { const found = findIdentity(value, target, depth + 1); if (found) return found; }
  }
  return null;
}

function classifyPageEvidence(evidence = {}, diagnostics = {}, identityResolved = true) {
  if (evidence.verification) return {code:'verification',message:'抖音页面出现了安全验证。请在工具打开的抖音窗口完成验证，程序会自动继续。'};
  if (evidence.unavailable) return {code:'video_unavailable',message:'抖音页面提示作品不可查看或已删除，请核对作品链接及访问权限。'};
  if (evidence.loginWall) return {code:'login_required',message:'该作品的评论区要求登录。请在工具打开的抖音窗口登录，程序检测到后会自动继续；其他浏览器的登录不会同步到这个窗口。'};
  if (diagnostics.httpStatus) return {code:'http_error',message:`评论请求返回 HTTP ${diagnostics.httpStatus}，程序将自动等待并重试。`};
  if (diagnostics.nonJson) return {code:'invalid_response',message:'评论响应暂时无法读取，程序将自动重新加载。'};
  if (!evidence.commentPanel && !evidence.visibleComments) return {code:'comments_not_open',message:'正在自动打开评论区并检查加载状态。'};
  if (!diagnostics.responseCount) return {code:'no_response',message:'尚未收到该作品的评论数据，程序将自动等待并重试。'};
  if (!identityResolved) return {code:'identity_unresolved',message:'已读取评论，正在自动核对目标抖音号的账号标识。'};
  return {code:'no_progress',message:'评论加载暂无进展，程序将自动重新加载未完成的范围。'};
}

async function readPageEvidence(page) {
  return page.evaluate(() => {
    const visible = e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); return r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && s.visibility!=='hidden' && s.display!=='none'; };
    const leaves = [...document.querySelectorAll('div,span,p,button')].filter(e=>e.children.length<3 && visible(e));
    const text = leaves.map(e=>(e.innerText||'').trim()).filter(t=>t.length<160).join('\n');
    const items = [...document.querySelectorAll('[data-e2e="comment-item"],[data-e2e="comment-list"],[class*="comment-item"]')].filter(visible);
    return {
      loginWall:/登录后(?:可)?(?:查看|查看更多|浏览|阅读).{0,8}评论|登录(?:后)?才能.{0,8}评论/.test(text),
      verification:/拖动滑块|完成下方验证|请完成安全验证|请依次点击|安全验证中/.test(text),
      unavailable:/作品不存在|视频不存在|作品已删除|视频已删除|私密作品|暂无权限查看/.test(text),
      commentPanel:items.length>0 || /全部评论|暂时没有评论|暂无评论|评论\s*[（(]\s*\d+\s*[）)]/.test(text),
      visibleComments:items.filter(e=>e.getAttribute('data-e2e')==='comment-item').length,
      guest:leaves.some(e=>(e.innerText||'').trim()==='登录'),
    };
  });
}

// Operates normal page controls. No request signing, CAPTCHA solver, proxy rotation or hidden APIs.
async function advanceComments(page, options = {}) {
  return page.evaluate(({includeReplies,rewind}) => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
    const nodes = [...document.querySelectorAll('button,[role="button"],span,div')];
    // Only click the leaf control that expands replies; never the reply composer / like button.
    const candidates = nodes.filter(el => {
      if (!visible(el) || el.children.length > 2) return false;
      const t = (el.innerText || '').trim();
      return t.length < 35 && /^(?:展开|查看|加载)(?:更多|全部|剩余)?\s*\d*\s*条?回复(?:\s*[⌄∨▼>]\s*)?$/.test(t);
    });
    const expand = includeReplies && !rewind && candidates.find(el => !el.dataset.dcfExpandedAt || Date.now() - Number(el.dataset.dcfExpandedAt) > 6500);
    if (expand) { expand.dataset.dcfExpandedAt = String(Date.now()); expand.click(); return {action:'expand'}; }
    const containers = [...document.querySelectorAll('[data-e2e*="comment"],[class*="comment"],[id*="comment"]')];
    const scrollables = [];
    const inspected = new Set();
    for (const el of containers) {
      let p = el;
      // The standalone video route nests its page scroller seven levels above
      // the comment list. Inspect ancestors to the document instead of stopping
      // at an arbitrary depth; each shared ancestor is inspected only once.
      for (; p && !inspected.has(p); p = p.parentElement) {
        inspected.add(p);
        const style = getComputedStyle(p);
        if (visible(p) && p.scrollHeight > p.clientHeight + 8 && (/(auto|scroll)/.test(style.overflowY) || p===document.scrollingElement)) scrollables.push(p);
      }
    }
    // Nested reply or composer panes can be shorter than the real comment list.
    // Prefer the pane containing the most comment rows, then its closest scroller.
    const score=p=>p.querySelectorAll('[data-e2e="comment-item"]').length;
    const panel = [...new Set(scrollables)].sort((a,b) => score(b)-score(a) || a.clientHeight-b.clientHeight)[0];
    if (panel) {
      const before = panel.scrollTop;
      if(rewind) panel.scrollTop=0;
      else panel.scrollBy(0, Math.max(300, panel.clientHeight * .85));
      return {action:rewind?'rewind':'scroll',moved:panel.scrollTop !== before,top:Math.round(panel.scrollTop),height:panel.clientHeight,totalHeight:panel.scrollHeight,rows:score(panel)};
    }
    // Standalone video pages can render comments below the player. They still
    // need revealing when no comment scroller currently intersects the viewport.
    const rows=[...document.querySelectorAll('[data-e2e="comment-item"]')].filter(el=>{
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none';
    });
    if(rows.length) { (rewind?rows[0]:rows.at(-1)).scrollIntoView({block:rewind?'start':'end'}); return {action:'reveal_row',rows:rows.length}; }
    return {action:'no_panel'};
  },{includeReplies:options.includeReplies !== false,rewind:!!options.rewind});
}

class BrowserScanner {
  constructor(job, publish, options = {}) {
    this.job = job; this.publish = publish; this.options = options;
    this.input = parseVideoInput(job.videoUrl); this.target = parseTargetInput(job.target);
    this.context = null; this.page = null; this.ledger = null; this.identity = null;
    this.queue = []; this.pending = new Set(); this.stopped = false; this.resuming = false;
    this.phase = 'init'; this.lastDataAt = 0; this.activeMs = 0; this.runningPromise = null;
    this.delay = options.delay || delay;
    this.now = options.now || Date.now;
    this.scanStartedAt = null; this.wakeWait = null;
    this.nextIdentityAt = 0;
    this.job.automatic = {enabled:true,retryAttempt:0,maxRetries:3};
    this.browser = null; this.identityPage = null; this.identityTask = null;
    this.transportFailures = new Map();
    this.accessBlock = null;
    this.diagnostics = {httpStatus:null,nonJson:false,responseCount:0,lastAcceptedAt:0,identityError:null};
  }
  update(phase, message, status = 'running') {
    if (this.stopped && phase !== 'done') return;
    this.phase = phase; Object.assign(this.job,{phase,message,status,updatedAt:new Date().toISOString()});
    if (this.job.logs.at(-1) !== message) this.job.logs.push(message);
    this.job.logs = this.job.logs.slice(-35); this.refresh();
  }
  refresh() {
    if (this.ledger) {
      this.job.result = this.ledger.snapshot();
      if (this.accessBlock) {
        this.job.result.complete=false;
        if(this.job.result.coverage) Object.assign(this.job.result.coverage,{scopeComplete:false,allCommentsComplete:false});
        this.job.result.verdict=this.job.result.matches.length ? 'found' : 'incomplete';
        this.job.result.reason=this.finalReason || this.accessBlock.message;
        this.job.result.diagnostics.unshift(this.accessBlock.message);
      }
      this.job.counts = this.job.result.stats;
    }
    this.publish(this.job);
  }
  async launch() {
    if (this.stopped) return;
    const launch = this._launch();
    this.launchPromise = launch;
    try { await launch; } finally { if (this.launchPromise === launch) this.launchPromise = null; }
  }
  async _launch() {
    const {chromium} = this.options.playwright || loadPlaywright();
    const profile = this.options.profileDir || path.join(__dirname,'..','.local','browser');
    const guest = this.job.sessionMode === 'guest';
    if (!guest) fs.mkdirSync(profile,{recursive:true});
    const options = {headless:!!this.options.headless,viewport:{width:1280,height:850},acceptDownloads:false};
    const launchErrors = [];
    for (const channel of process.platform === 'win32' ? ['msedge','chrome',undefined] : [undefined,'chrome']) {
      if (this.stopped) return;
      try {
        if (guest) {
          this.browser = await chromium.launch({headless:options.headless,...(channel ? {channel} : {})});
          this.context = await this.browser.newContext({viewport:options.viewport,acceptDownloads:false});
        } else this.context = await chromium.launchPersistentContext(profile,{...options,...(channel ? {channel} : {})});
        if (this.stopped) { await this.context.close(); this.context = null; return; }
        break;
      }
      catch (error) { launchErrors.push(error); if (this.browser) await this.browser.close().catch(()=>{}); this.browser=null; }
    }
    if (!this.context) {
      const diagnostic=describeLaunchError(new AggregateError(launchErrors));
      this.job.diagnostic=diagnostic;
      throw new Error(`${diagnostic.message}${diagnostic.action}`);
    }
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(5000);
    this.context.on('response',response => {
      const task = this.onResponse(response).catch(() => {
        if (!this.stopped) { this.diagnostics.nonJson = true; this.refresh(); }
      });
      this.pending.add(task); task.finally(() => this.pending.delete(task));
    });
    this.page.on('close',() => { if (!this.stopped) this.finish('浏览器窗口已关闭，检索提前结束'); });
  }
  async onResponse(response) {
    const url = response.url(); if (!isDouyin(url) || this.stopped) return;
    const u = new URL(url); const comments = /^\/aweme\/v1\/web\/comment\/list\/(?:reply\/)?$/.test(u.pathname);
    const profile = /\/user\/profile\/|\/search\//.test(u.pathname);
    if (!comments && !profile) return;
    const wantedId = this.ledger?.videoId || this.input.videoId;
    if (comments && wantedId && (u.searchParams.get('aweme_id') || u.searchParams.get('item_id')) !== wantedId) return;
    const responseKey = [u.pathname,u.searchParams.get('aweme_id')||u.searchParams.get('item_id'),u.searchParams.get('comment_id'),u.searchParams.get('cursor')||'0'].join('|');
    if (response.status() >= 400) {
      if (comments) this.recordResponseFailure(responseKey,url,{httpStatus:response.status(),nonJson:false});
      return;
    }
    let body; try { body = await response.json(); } catch { if (comments && !this.stopped) this.recordResponseFailure(responseKey,url,{httpStatus:null,nonJson:true}); return; }
    if (this.stopped) return;
    const identity = findIdentity(body,this.target);
    if (identity) {
      this.identity = identity;
      if (this.ledger) this.ledger.setTargetIdentity(identity);
    }
    if (comments) {
      this.transportFailures.delete(responseKey); this.refreshTransportDiagnostics();
      this.diagnostics.responseCount++;
      if (this.ledger) { const accepted = this.ledger.ingest(url,body); if (accepted.accepted) this.diagnostics.lastAcceptedAt = this.lastDataAt = this.now(); this.refresh(); }
      else if (this.queue.length < 100) this.queue.push({url,body});
    }
  }
  recordResponseFailure(key,url,failure) {
    this.transportFailures.set(key,failure); this.refreshTransportDiagnostics();
    // Cursor errors are recoverable: ingest replaces them when that page succeeds.
    const body = {status_code:-1};
    if (this.ledger) this.ledger.ingest(url,body);
    else if (this.queue.length<100) this.queue.push({url,body});
    this.refresh();
  }
  refreshTransportDiagnostics() {
    const failures = [...this.transportFailures.values()];
    this.diagnostics.httpStatus = failures.find(x=>x.httpStatus)?.httpStatus || null;
    this.diagnostics.nonJson = failures.some(x=>x.nonJson);
  }
  async start() {
    try {
      this.scanStartedAt ??= this.now();
      this.update('launching',this.job.sessionMode==='guest' ? '正在打开未登录临时会话，直接尝试读取作品评论。' : '正在打开本工具的浏览器会话，直接尝试读取作品评论。');
      await this.launch(); if (this.stopped) return;
      await this.openVideo();
    } catch (error) { await this.fail(error); }
  }
  async openVideo() {
    if (this.stopped) return;
    this.update('opening','正在打开指定作品并等待评论加载。');
    for(let attempt=0;attempt<4;attempt++) {
      if(this.stopped) return;
      if(this.timeRemaining()<=0) { await this.finish('已达到本次检查时间上限'); return; }
      try { await this.page.goto(this.input.url,{waitUntil:'domcontentloaded',timeout:Math.max(1,Math.min(45000,this.timeRemaining()))}); break; }
      catch(error) {
        if(this.stopped) return;
        if(attempt===3) throw new Error('自动重试后仍无法打开作品，请核对链接或网络连接。');
        this.update('recovering',`作品暂未打开，正在自动重试（${attempt+1}/3）。`);
        await this.pause(3000*2**attempt);
      }
    }
    await this.delay(2200); if (this.stopped) return;
    let videoId = this.input.videoId;
    if (!videoId) {
      const urls = [this.page.url(),await this.page.locator('link[rel="canonical"]').getAttribute('href',{timeout:1000}).catch(()=>null)];
      for (const url of urls.filter(Boolean)) { try { videoId = parseVideoInput(url).videoId; if (videoId) break; } catch {} }
    }
    if (!videoId) { await this.finish('短链接未能解析为具体作品，请改用完整视频或图文作品链接。'); return; }
    this.ledger = new ScanLedger(videoId,this.target,{replyThreshold:this.job.replyThreshold ?? 100});
    if (this.identity) this.ledger.setTargetIdentity(this.identity);
    for (const entry of this.queue) this.ledger.ingest(entry.url,entry.body);
    this.queue = []; this.lastDataAt = this.now();
    this.job.resolvedVideoUrl = `https://www.douyin.com/video/${videoId}`;
    try { const resolved=parseVideoInput(this.page.url()); if (resolved.videoId===videoId) this.job.resolvedVideoUrl=resolved.url; } catch {}
    await this.openComments();
    await this.runScan();
  }
  async openComments() {
    const firstRow=this.page.locator('[data-e2e="comment-item"]').first();
    if (await firstRow.isVisible().catch(()=>false)) {
      await firstRow.scrollIntoViewIfNeeded({timeout:2000}).catch(()=>{});
      return;
    }
    // Image posts have a separate 评论(n) tab instead of the video player's icon.
    const tab = this.page.getByText(/^评论\s*[（(]\s*[\d.万wW]+\s*[）)]$/).first();
    if (await tab.isVisible().catch(()=>false)) { await tab.click({timeout:2000}).catch(()=>{}); await this.delay(1000); return; }
    const list=this.page.locator('[data-e2e="comment-list"]').first();
    if (await list.isVisible().catch(()=>false)) {
      await list.scrollIntoViewIfNeeded({timeout:2000}).catch(()=>{});
      return;
    }
    // Prefer the site's semantic comment control when the list is not rendered.
    const selectors = ['[data-e2e="video-player-comment"]','[data-e2e="comment-icon"]','button[aria-label="评论"]'];
    for (const selector of selectors) {
      const control = this.page.locator(selector).first();
      if (await control.isVisible().catch(()=>false)) { await control.click().catch(()=>{}); await this.delay(1200); break; }
    }
  }
  async resolveIdentity() {
    if (this.target.kind!=='handle' || this.identity || this.identityTask || this.stopped || this.now()<this.nextIdentityAt) return;
    this.nextIdentityAt=this.now()+30000;
    const task = (async()=>{
      try {
        if (!this.identityPage || this.identityPage.isClosed()) this.identityPage=await this.context.newPage();
        await this.identityPage.goto(`https://www.douyin.com/search/${encodeURIComponent(this.target.value)}?type=user`,{waitUntil:'domcontentloaded',timeout:30000});
        await this.delay(1500);
        if (!this.identity && !this.stopped) await this.identityPage.getByText('用户',{exact:true}).first().click({timeout:1500}).catch(()=>{});
        if (!this.stopped) await this.page.bringToFront().catch(()=>{});
      } catch { this.diagnostics.identityError='账号搜索页未能加载；评论检查继续进行'; }
    })();
    this.identityTask=task;
    try { await task; } finally { if(this.identityTask===task) this.identityTask=null; }
  }
  async diagnose() {
    const evidence=await this.withPageReady(()=>readPageEvidence(this.page));
    try { const resolved=parseVideoInput(this.page.url()); if(resolved.videoId===this.ledger?.videoId) this.job.resolvedVideoUrl=resolved.url; } catch {}
    const diagnostic=classifyPageEvidence(evidence,this.diagnostics,this.ledger?.identityResolved ?? this.target.kind==='sec_uid');
    this.accessBlock=['verification','video_unavailable','login_required'].includes(diagnostic.code) ? diagnostic : null;
    this.job.diagnostic={...diagnostic,evidence,network:{...this.diagnostics}};
    return diagnostic;
  }
  async withPageReady(action) {
    for (let attempt=0; attempt<4; attempt++) {
      try { return await action(); }
      catch (error) {
        if (this.stopped || !/Execution context was destroyed|Cannot find context|navigation/i.test(error.message) || attempt===3) throw error;
        await this.page.waitForLoadState('domcontentloaded',{timeout:8000}).catch(()=>{});
        await this.delay(700);
      }
    }
  }
  async runScan() {
    if (this.stopped) return;
    while (this.runningPromise) await this.runningPromise;
    if (this.stopped) return;
    const run = this._scanLoop();
    this.runningPromise = run;
    try { await run; } finally { if (this.runningPromise === run) this.runningPromise = null; }
  }
  async _scanLoop() {
    if (this.stopped) return;
    this.scanStartedAt ??= this.now();
    let noPanel=0,retries=0,lastProgress=this.now(),lastToken='',waitingForAccess=false,replySweep=false;
    this.update('scanning','正在自动读取评论数量并选择检索范围。');
    while (!this.stopped) {
      if (this.now()-this.scanStartedAt >= this.job.maxMinutes*60000) { await this.finish('已达到本次检查时间上限，保留已有结果'); return; }
      try {
        const diagnostic=await this.diagnose();
        if(this.stopped) return;
        if(diagnostic.code==='video_unavailable') { await this.finish(diagnostic.message); return; }
        if(this.accessBlock) {
          waitingForAccess=true;
          this.update(diagnostic.code,diagnostic.message,'waiting');
          await this.pause(2500);
          continue;
        }
        if(waitingForAccess) {
          waitingForAccess=false;
          this.update('recovering','已检测到登录或验证完成，正在自动恢复原作品的检索。');
          await this.reloadVideo();
          lastProgress=this.now(); noPanel=0;
          continue;
        }
        const result=this.ledger.snapshot(); this.refresh();
        if(result.complete) { await this.finish(); return; }
        const mode=this.ledger.scope?.().mode || 'all';
        const token=[result.stats.comments,result.stats.replies,result.stats.pages,this.ledger.identityResolved,mode].join('|');
        if(token!==lastToken) { if(lastToken) retries=0; lastToken=token; lastProgress=this.now(); this.job.automatic.retryAttempt=retries; }
        const checked=result.stats.comments+(mode==='main_only'?0:result.stats.replies);
        if(checked>=this.job.maxComments) { await this.finish('已达到本次评论检查上限'); return; }
        const label=mode==='main_only' ? '评论较多，正在自动检查一级评论；本轮不展开楼中楼。' : mode==='all' ? '评论较少，正在自动检查全部一级评论和楼中楼。' : '正在读取评论数量，暂不展开楼中楼。';
        this.update('scanning',label);
        void this.resolveIdentity();
        // Once the first-level list is complete, revisit earlier parents for remaining replies.
        const rewind=mode==='all' && result.stats.mainComplete && !replySweep;
        if(rewind) replySweep=true;
        const action=await this.withPageReady(()=>advanceComments(this.page,{includeReplies:mode==='all' && result.stats.mainComplete,rewind}));
        this.job.automatic.lastAction=action;
        noPanel=action.action==='no_panel'?noPanel+1:0;
        if(noPanel===3) await this.openComments();
        await this.pause(1400);
        if(this.stopped) return;
        if(noPanel>=6 || this.now()-lastProgress>20000) {
          const latest=await this.diagnose();
          if(this.accessBlock) continue;
          if(this.ledger.snapshot().complete) { await this.finish(); return; }
          if(retries>=3) { await this.finish(`自动重试后仍无法完成检索：${this.ledger.snapshot().diagnostics[0] || latest.message}`); return; }
          await this.recover(++retries,latest.message);
          lastProgress=this.now(); noPanel=0; replySweep=false;
        }
      } catch(error) {
        if(this.stopped) return;
        if(retries>=3) { await this.finish('自动重试后网页仍无法正常加载，已保留读取到的结果'); return; }
        await this.recover(++retries,'网页暂时无法加载');
        lastProgress=this.now(); noPanel=0;
      }
    }
  }
  async pause(ms) {
    if(this.stopped) return;
    ms=Math.max(0,Math.min(ms,this.timeRemaining()));
    if(this.options.delay) { await this.delay(ms); return; }
    await new Promise(resolve=>{
      const timer=setTimeout(()=>{this.wakeWait=null;resolve();},ms);
      this.wakeWait=()=>{clearTimeout(timer);this.wakeWait=null;resolve();};
    });
  }
  async reloadVideo() {
    if(this.stopped) return;
    let currentId; try { currentId=parseVideoInput(this.page.url()).videoId; } catch {}
    const timeout=Math.max(1,Math.min(45000,this.timeRemaining()));
    if(currentId===this.ledger?.videoId) await this.page.reload({waitUntil:'domcontentloaded',timeout});
    else await this.page.goto(this.job.resolvedVideoUrl || this.input.url,{waitUntil:'domcontentloaded',timeout});
    await this.delay(2200); if(this.stopped) return;
    await this.openComments(); this.lastDataAt=this.now();
  }
  async recover(attempt,reason) {
    if(this.stopped) return;
    this.job.automatic.retryAttempt=attempt;
    this.update('recovering',`${reason} 正在自动重试（${attempt}/3）。`);
    await this.pause(3000*2**(attempt-1));
    if(this.stopped) return;
    try { await this.reloadVideo(); } catch { /* The next iteration retries within the same budget. */ }
  }
  timeRemaining() { return this.job.maxMinutes*60000-(this.scanStartedAt===null ? 0 : this.now()-this.scanStartedAt); }
  async resume() {
    if (this.stopped || this.resuming || this.job.status !== 'waiting') return;
    // Older clients may still call continue; the automatic loop already owns recovery.
    if(this.runningPromise) return;
    this.resuming = true;
    try {
      if (!this.ledger) {
        try { const resolved = parseVideoInput(this.page.url()); if (resolved.videoId) this.input = resolved; } catch {}
        await this.openVideo();
      } else {
        this.update('opening','正在重新加载指定作品，使用这个窗口当前的登录状态再次读取评论。');
        await this.reloadVideo(); await this.runScan();
      }
    } catch (error) { await this.fail(error); } finally { this.resuming = false; }
  }
  async finish(reason) {
    if (this.stopped) return; this.stopped = true;
    this.finalReason=reason;
    this.wakeWait?.();
    if (this.ledger && reason) this.ledger.markIssue(reason);
    if (this.ledger) this.job.result = this.ledger.snapshot();
    else this.job.result = {verdict:'incomplete',complete:false,reason:reason || '尚未开始读取评论',matches:[],stats:{comments:0,replies:0,unresolved:0}};
    const r = this.job.result;
    this.update('done',reason || r.reason || '检查尚未完成','finished');
  }
  async fail(error) { await this.finish(`检查未完成：${error?.message || '浏览器运行失败'}`); }
  async stop() { await this.finish('用户停止了本次检查'); }
  async close() {
    this.stopped = true;
    this.wakeWait?.();
    if (this.launchPromise) await this.launchPromise.catch(()=>{});
    if (this.context) await this.context.close().catch(()=>{});
    if (this.browser) await this.browser.close().catch(()=>{});
  }
}
module.exports = {BrowserScanner,advanceComments,findIdentity,isDouyin,classifyPageEvidence,readPageEvidence};
