'use strict';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['search-form','video-url','target','session-mode','max-minutes','max-comments','reply-threshold','start-button','form-error','status-label','empty-state','job-content','job-title','job-message','job-target','job-video','job-session','job-scope','comments-count','replies-count','unresolved-count','stop-button','job-actions','coverage-note','matches-section','matches-list','match-count','empty-result','log-count','log-list','verdict-icon','connection-error','demo-banner','export-csv','export-json','result-exports'].map(id => [id,$(id)]));
let currentJob = null;
let lastJobSignature = '';
let demoMode = false;
let actionPending = false;
let initialInputsRestored = false;
const editedInputs = new Set();
for (const id of ['video-url','target','session-mode','max-minutes','max-comments','reply-threshold']) {
  for (const event of ['input','change']) ui[id].addEventListener(event,() => editedInputs.add(id));
}

function restoreInitialInputs(job) {
  if (initialInputsRestored) return;
  initialInputsRestored = true;
  if (!job) return;
  const values = {
    'video-url': job.videoUrl || job.resolvedVideoUrl,
    target: typeof job.target === 'string' ? job.target : undefined,
    'session-mode': ['saved','guest'].includes(job.sessionMode) ? job.sessionMode : 'saved',
    'max-minutes': job.maxMinutes,
    'max-comments': job.maxComments,
    'reply-threshold': job.replyThreshold ?? 100,
  };
  for (const [id,value] of Object.entries(values)) {
    if (!editedInputs.has(id) && value !== undefined && value !== null) ui[id].value = String(value);
  }
}

function waitingTitle(job) {
  const code = String(job.diagnostic?.code || '').toLowerCase();
  if (['login','login_required','login_needed','authentication_required'].includes(code)) return '等待登录，完成后自动继续';
  if (['captcha','verification','verification_required','verify_required','verification_needed'].includes(code)) return '等待验证，完成后自动继续';
  if (['identity','identity_unresolved','identity_required','identity_missing','identity_pending'].includes(code)) return '正在自动核验目标账号';
  if (['network','network_error','network_timeout','request_failed','http_error','timeout'].includes(code)) return '网页请求暂未成功，自动重试中';
  if (code === 'invalid_response') return '评论响应暂时无法读取，自动重试中';
  if (code === 'no_response') return '正在等待评论数据并自动重试';
  if (['panel_missing','no_panel','comments_panel_missing','comments_not_open'].includes(code)) return '正在重新打开评论区';
  if (['page_unavailable','video_unavailable','work_unavailable'].includes(code)) return '作品页面暂不可用';
  if (['no_progress','stalled'].includes(code)) return '评论加载暂未继续，自动重试中';
  return '正在自动等待并重试';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function safeDouyinUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return url.href;
  } catch {}
  return null;
}

function link(text, href) {
  const anchor = element('a', '', text);
  const safe = safeDouyinUrl(href);
  if (!safe) return element('span', '', text);
  anchor.href = safe;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function dateLabel(value) {
  if (!value) return '时间未提供';
  const parsed = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
}

function count(value) { return (Number(value) || 0).toLocaleString('zh-CN'); }
function isActive(job) { return Boolean(job && (job.status === 'running' || job.status === 'waiting')); }

function updateButtons() {
  const active = isActive(currentJob);
  $('show-demo').disabled = active || actionPending;
  ui['start-button'].disabled = active || actionPending;
  ui['start-button'].querySelector('span').textContent = actionPending ? '正在处理…' : active ? '检查进行中' : '开始检查';
  for (const id of ['video-url','target','session-mode','max-minutes','max-comments','reply-threshold']) ui[id].disabled = active || actionPending;
  ui['stop-button'].hidden = !active;
  ui['stop-button'].disabled = actionPending;
  ui['job-actions'].hidden = !active;
}

function icon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox','0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'check' ? 'm6 12 4 4 8-8' : kind === 'warning' ? 'M12 6v7M12 17h.01' : 'M12 7v5l3 2M20 12a8 8 0 1 1-4-7');
  svg.append(path);
  ui['verdict-icon'].replaceChildren(svg);
  ui['verdict-icon'].dataset.tone = kind === 'warning' ? 'amber' : 'green';
}

function renderMatches(matches, job) {
  ui['matches-list'].replaceChildren();
  for (const match of matches) {
    const article = element('article','comment-item');
    const meta = element('div','comment-meta');
    meta.append(element('span','comment-kind',match.parentId ? '楼中楼回复' : '一级评论'),element('time','',dateLabel(match.time)));
    article.append(meta,element('p','comment-text',match.text || '（评论正文为空或不可用）'));
    const bottom = element('div','comment-bottom');
    const matchBy = ({sec_uid:'主页标识匹配',sec_user_id:'主页标识匹配',uid:'账号 ID 匹配',unique_id:'抖音号匹配',short_id:'抖音号匹配',profile:'主页匹配'})[match.matchBy] || '账号标识匹配';
    bottom.append(element('span','',matchBy));
    const links = element('span','comment-links');
    if (match.authorUrl) links.append(link('查看作者',match.authorUrl));
    const videoUrl = safeDouyinUrl(job.resolvedVideoUrl) || safeDouyinUrl(job.videoUrl) || (match.videoId && /^\d+$/.test(String(match.videoId)) ? `https://www.douyin.com/video/${match.videoId}` : null);
    if (videoUrl) links.append(link('打开作品',videoUrl));
    bottom.append(links); article.append(bottom); ui['matches-list'].append(article);
  }
}

function render(job, force = false) {
  if (!demoMode) currentJob = job;
  updateButtons();
  ui['demo-banner'].hidden = !demoMode;
  ui['empty-state'].hidden = Boolean(job);
  ui['job-content'].hidden = !job;
  if (!job) { ui['status-label'].textContent = '等待开始'; ui['status-label'].dataset.state = ''; lastJobSignature = ''; return; }
  const signature = JSON.stringify(job);
  if (signature === lastJobSignature && !force) return;
  lastJobSignature = signature;
  const result = job.result;
  const finished = job.status === 'finished';
  const verdict = result?.verdict;
  const matches = Array.isArray(result?.matches) ? result.matches : [];
  const coverage = result?.coverage;
  const mainOnly = coverage?.scope === 'main_only';
  let title = '正在检查评论';
  let badge = '检查中';
  let tone = 'progress';
  if (job.status === 'waiting') {
    title = waitingTitle(job); badge = ['login_required','verification'].includes(job.diagnostic?.code) ? '自动等待' : '自动重试'; tone = 'warning';
    if (matches.length && job.diagnostic?.code === 'no_progress') { title = `已找到 ${matches.length} 条，部分范围待核验`; badge = '已找到'; tone = 'check'; }
  }
  if (finished) {
    if (verdict === 'found') { title = `找到 ${matches.length} 条匹配评论${mainOnly ? '（仅一级）' : ''}`; badge = '已找到'; tone = 'check'; }
    else if (verdict === 'not_found') { title = mainOnly ? '一级评论中未找到匹配' : '本次检查未找到匹配评论'; badge = mainOnly ? '一级检查完成' : '检查完成'; tone = 'check'; }
    else { title = '检查尚未完成'; badge = '检查未完成'; tone = 'warning'; }
  }
  ui['job-title'].textContent = title;
  ui['status-label'].textContent = badge;
  ui['status-label'].dataset.state = finished ? (verdict || 'incomplete') : job.status;
  ui['job-message'].textContent = (finished ? result?.reason || job.message : job.message || result?.reason) || '正在准备浏览器…';
  ui['job-target'].textContent = typeof job.target === 'string' ? job.target : (job.target?.input || job.target?.secUid || job.target?.uid || '已指定账号');
  ui['job-session'].textContent = demoMode ? '演示（未启动浏览器）' : job.sessionMode === 'guest' ? '未登录临时会话' : '本工具已有会话';
  const threshold = coverage?.replyThreshold ?? job.replyThreshold ?? 100;
  const total = Number.isFinite(coverage?.observedTotal) ? `（已知总数 ${count(coverage.observedTotal)} 条）` : '';
  ui['job-scope'].textContent = mainOnly ? `仅一级评论 · 楼中楼未检索${total}` : coverage?.scope === 'all' ? `一级评论及楼中楼${total}` : `自动判断 · 不超过 ${count(threshold)} 条时检查楼中楼`;
  const safeVideo = safeDouyinUrl(job.resolvedVideoUrl) || safeDouyinUrl(job.videoUrl);
  ui['job-video'].textContent = safeVideo || job.videoUrl || '待解析';
  if (safeVideo) ui['job-video'].href = safeVideo; else ui['job-video'].removeAttribute('href');
  const stats = result?.stats || job.counts || {};
  ui['comments-count'].textContent = count(stats.comments);
  ui['replies-count'].textContent = count(stats.replies);
  ui['unresolved-count'].textContent = count(stats.unresolved);
  icon(tone);
  ui['coverage-note'].hidden = !finished && !mainOnly;
  ui['coverage-note'].textContent = mainOnly
    ? `${result?.complete ? '一级评论检查完成。' : '本次仅检查一级评论。'}评论数量超过全量检索阈值（${count(threshold)} 条），楼中楼未检索；不能据此判断该账号在楼中楼中是否有评论。`
    : result?.complete
      ? '检查范围：本次浏览器会话中，指定作品返回的可读取一级评论及楼中楼。平台隐藏、删除或未提供的内容不在检查范围内。'
      : '本次未覆盖全部可检查内容。已有匹配仍可查看；未找到匹配也不能据此判定该账号没有评论。';
  ui['matches-section'].hidden = !matches.length;
  ui['result-exports'].hidden = demoMode || !finished || !result;
  ui['match-count'].textContent = `${matches.length} 条`;
  ui['empty-result'].hidden = !finished || Boolean(matches.length);
  ui['empty-result'].textContent = verdict === 'not_found' ? (mainOnly ? '已检查的一级评论中没有匹配到目标账号。楼中楼尚未检索。' : '在本次已检查的一级评论及楼中楼中，没有匹配到目标账号。') : '目前没有匹配结果。请查看上方未完成原因，处理后可重新检查。';
  renderMatches(matches,job);
  ui['export-csv'].hidden = demoMode;
  ui['export-json'].hidden = demoMode;
  const logs = Array.isArray(job.logs) ? job.logs : [];
  ui['log-count'].textContent = `${logs.length} 条`;
  ui['log-list'].replaceChildren(...logs.slice(-100).map(line => element('li','',typeof line === 'string' ? line : JSON.stringify(line))));
}

async function api(path, body) {
  const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let data;
  try { data = await response.json(); } catch { throw new Error('本地服务返回了无法读取的响应。请确认服务仍在运行。'); }
  if (!response.ok) throw new Error(data.error?.message || data.error || data.message || '操作失败，请重试。');
  return data;
}

async function action(path, body) {
  if (actionPending) return;
  actionPending = true; ui['form-error'].hidden = true; updateButtons();
  try {
    const data = await api(path,body);
    demoMode = false;
    if (Object.hasOwn(data,'job')) render(data.job,true);
    await poll();
  } catch (error) { ui['form-error'].textContent = error.message; ui['form-error'].hidden = false; }
  finally { actionPending = false; updateButtons(); }
}

ui['search-form'].addEventListener('submit',event => {
  event.preventDefault();
  if (!ui['search-form'].reportValidity()) return;
  const videoUrl = ui['video-url'].value.trim(), target = ui.target.value.trim();
  if (!videoUrl || !target) { ui['form-error'].textContent = '请填写作品链接和目标账号。'; ui['form-error'].hidden = false; return; }
  action('/api/start',{videoUrl,target,sessionMode:ui['session-mode'].value,maxMinutes:Number(ui['max-minutes'].value),maxComments:Number(ui['max-comments'].value),replyThreshold:Number(ui['reply-threshold'].value)});
});
ui['stop-button'].addEventListener('click',() => action('/api/stop',{}));

$('show-demo').addEventListener('click',() => {
  if (isActive(currentJob) || actionPending) return;
  demoMode = true;
  render({id:'demo',status:'finished',target:'演示账号（非真实账号）',videoUrl:'演示视频（未打开任何抖音链接）',message:'',result:{verdict:'found',complete:false,reason:'以下为演示数据，展示命中评论和未完成范围的呈现方式。',matches:[{id:'demo-1',text:'这一段讲得很清楚，尤其是最后那个例子。',time:'2026-01-15T14:32:00+08:00',videoId:null,parentId:null,matchBy:'sec_user_id'},{id:'demo-2',text:'我也是这样理解的，谢谢你的补充。',time:'2026-01-15T14:38:00+08:00',videoId:null,parentId:'demo-parent',matchBy:'sec_user_id'}],stats:{comments:128,replies:46,unresolved:3}},logs:['演示：解析指定视频与目标账号','演示：检查一级评论 128 条、楼中楼回复 46 条','演示：找到 2 条匹配；仍有 3 项未核验']},true);
});
$('exit-demo').addEventListener('click',() => {demoMode = false; render(currentJob,true); poll();});

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch('/api/state',{cache:'no-store'});
    if (!response.ok) throw new Error('connection');
    const data = await response.json();
    ui['connection-error'].hidden = true;
    currentJob = data.job || null;
    restoreInitialInputs(currentJob);
    if (isActive(currentJob)) demoMode = false;
    if (!demoMode) render(currentJob); else updateButtons();
  } catch { ui['connection-error'].hidden = false; }
  finally { polling = false; }
}
poll();
setInterval(poll,1500);
