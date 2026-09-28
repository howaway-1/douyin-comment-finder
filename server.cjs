'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {parseVideoInput,parseTargetInput} = require('./lib/domain.cjs');
const {BrowserScanner} = require('./lib/browser.cjs');
const ROOT = __dirname;
const APP_ID = 'douyin-comment-finder';
const VERSION = '1.2.0';
function csvCell(value) {
  let str = String(value ?? '');
  if (/^[\s]*[=+@\-]/.test(str)) str = "'" + str;
  return '"' + str.replaceAll('"','""') + '"';
}
function exportCSV(result) {
  const fields = ['id','text','time','videoId','parentId','authorUrl','matchBy'];
  const coverage = result.coverage || {};
  const scope = coverage.scope === 'main_only' ? '仅一级评论（楼中楼未检索）' : coverage.scope === 'pending' ? '等待确定范围' : '一级评论及楼中楼';
  const lines = [['检索结论',result.verdict,'范围完整',result.complete,'检索范围',scope,
    '全部评论完整',coverage.allCommentsComplete ?? (coverage.scope === 'main_only' || coverage.scope === 'pending' ? false : Boolean(result.complete)),
    '全量检索阈值',result.replyThreshold ?? coverage.replyThreshold ?? 100,
    '任务状态',result.jobStatus || '', '浏览器会话',result.sessionMode || 'saved', '说明',result.reason || ''],fields];
  for (const row of result.matches || []) lines.push(fields.map(key => row[key]));
  return '\uFEFF' + lines.map(row=>row.map(csvCell).join(',')).join('\r\n');
}
function makeServer(options = {}) {
  let job = null,scanner = null,closing = false,starting = false,browserClosePromise = null,closePromise = null;
  const Scanner = options.Scanner || BrowserScanner;
  const stateFile = options.stateFile ? path.resolve(options.stateFile) : null;
  const saveJob = () => {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), {recursive:true});
      const temporaryFile = stateFile + '.tmp';
      fs.writeFileSync(temporaryFile, JSON.stringify({appId:APP_ID, version:VERSION, job}), 'utf8');
      fs.renameSync(temporaryFile, stateFile);
      if (job) delete job.persistenceError;
    } catch {
      if (job) job.persistenceError = '本次结果未能保存到本地，请在关闭工具前导出。';
    }
  };
  if (stateFile) {
    try {
      const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (stored.appId === APP_ID && stored.job && typeof stored.job.id === 'string' &&
          ['running','waiting','finished'].includes(stored.job.status)) {
        job = stored.job;
        if (!['saved','guest'].includes(job.sessionMode)) job.sessionMode = 'saved';
        if (!Number.isInteger(job.replyThreshold)) job.replyThreshold = 100;
        if (job.status !== 'finished') {
          const reason = '工具已重启，上次检查已中断；已找到的评论已保留，请重新开始检查。';
          const previous = job.result && typeof job.result === 'object' ? job.result : {};
          const matches = Array.isArray(previous.matches) ? previous.matches : [];
          job.result = {...previous, matches, verdict:matches.length ? 'found' : 'incomplete', complete:false, reason,
            ...(previous.coverage ? {coverage:{...previous.coverage,scopeComplete:false,allCommentsComplete:false}} : {}),
            stats:previous.stats || job.counts || {comments:0,replies:0,unresolved:0},
            diagnostics:[...new Set([...(Array.isArray(previous.diagnostics) ? previous.diagnostics : []), reason])]};
          Object.assign(job, {status:'finished', phase:'done', message:reason, updatedAt:new Date().toISOString()});
          job.counts = job.result.stats;
          job.logs = [...(Array.isArray(job.logs) ? job.logs : []), reason].slice(-35);
          saveJob();
        }
      }
    } catch { /* A missing or damaged local history must not prevent a fresh check. */ }
  }
  const server = http.createServer(async(req,res) => {
    const actualPort = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${actualPort}`,`localhost:${actualPort}`];
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const send = (code,data) => { res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
    if (!allowedHosts.includes(req.headers.host)) return send(403,{error:'仅允许本机访问'});
    let url;
    try { url = new URL(req.url,'http://127.0.0.1'); } catch { return send(400,{error:'请求路径无效'}); }
    if (req.method === 'POST') {
      if (closing) return send(503,{error:'工具正在关闭'});
      if (req.headers.origin && !allowedHosts.some(host=>req.headers.origin === `http://${host}`)) return send(403,{error:'请求来源不匹配'});
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(415,{error:'需要 JSON 请求'});
      let raw = '';
      try {
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw)>16384) return send(413,{error:'输入过长'}); }
        const body = raw ? JSON.parse(raw) : {};
        if (closing) return send(503,{error:'工具正在关闭'});
        if (url.pathname === '/api/start') {
          if (starting || (job && job.status !== 'finished')) return send(409,{error:'已有检查正在进行，请先停止当前检查'});
          const video = parseVideoInput(body.videoUrl);
          parseTargetInput(body.target);
          const sessionMode = body.sessionMode === undefined ? 'saved' : body.sessionMode;
          if (!['saved','guest'].includes(sessionMode)) return send(400,{error:'浏览器会话必须选择 saved 或 guest'});
          const maxMinutes = Number(body.maxMinutes ?? 5),maxComments = Number(body.maxComments ?? 1000);
          if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 30 || !Number.isInteger(maxComments) || maxComments < 100 || maxComments > 10000) return send(400,{error:'时限应为 1–30 分钟，评论上限应为 100–10000 条'});
          const replyThreshold = body.replyThreshold === undefined ? 100 : body.replyThreshold;
          if (!Number.isInteger(replyThreshold) || replyThreshold < 0 || replyThreshold > 10000) return send(400,{error:'全量检索阈值应为 0–10000 的整数'});
          starting = true;
          try {
            if (scanner) await scanner.close();
            job = {id:randomUUID(),status:'running',phase:'launching',message:'准备启动浏览器',videoUrl:video.url,target:String(body.target).trim(),sessionMode,maxMinutes,maxComments,replyThreshold,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),counts:{comments:0,replies:0,unresolved:0},result:null,logs:[]};
            saveJob();
            const activeScanner = new Scanner(job,updated=>{ if (job?.id === updated.id) { job = updated; saveJob(); } });
            scanner = activeScanner;
            Promise.resolve(activeScanner.start()).catch(error=>activeScanner.fail(error));
            return send(202,{job});
          } finally { starting = false; }
        }
        if (url.pathname === '/api/continue') {
          if (!scanner || job.status !== 'waiting') return send(409,{error:'当前没有等待继续的检查'});
          Promise.resolve(scanner.resume()).catch(error=>scanner.fail(error));
          return send(202,{job});
        }
        if (url.pathname === '/api/stop') { if (scanner) await scanner.stop(); return send(200,{job}); }
        if (url.pathname === '/api/shutdown') {
          if (starting) return send(409,{error:'浏览器正在启动，请稍后关闭工具'});
          await closeBrowser();
          send(200,{closed:true});
          void close();
          return;
        }
        return send(404,{error:'不存在的接口'});
      } catch(error) { return send(400,{error:error.message || '输入有误'}); }
    }
    if (req.method !== 'GET') return send(405,{error:'不支持的请求方式'});
    if (url.pathname === '/api/state') return send(200,{appId:APP_ID,version:VERSION,job});
    if (url.pathname === '/api/export') {
      if (!job?.result) return send(409,{error:'尚无可导出的检查结果'});
      const format = url.searchParams.get('format') || 'json';
      if (!['json','csv'].includes(format)) return send(400,{error:'仅支持 JSON 或 CSV'});
      const report = {schemaVersion:1,exportedAt:new Date().toISOString(),videoUrl:job.resolvedVideoUrl || job.videoUrl,target:job.target,jobStatus:job.status,startedAt:job.startedAt,...job.result,sessionMode:job.sessionMode || 'saved',replyThreshold:job.replyThreshold ?? 100};
      res.setHeader('Content-Type',format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',`attachment; filename="douyin-comments-${job.id}.${format}"`);
      return res.end(format === 'json' ? JSON.stringify(report,null,2) : exportCSV(report));
    }
    const pages = {'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js'};
    const file = pages[url.pathname]; if (!file) return send(404,{error:'页面不存在'});
    const ext = path.extname(file);
    res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'})[ext]);
    try { res.end(fs.readFileSync(path.join(ROOT,'public',file))); } catch { send(503,{error:'界面文件尚未准备完成'}); }
  });
  const closeBrowser = () => {
    closing = true;
    return browserClosePromise ||= (async() => { if (scanner) await scanner.close(); saveJob(); })();
  };
  const close = () => closePromise ||= closeBrowser().then(() => new Promise(resolve => server.close(() => resolve())));
  return {server,close};
}
if (require.main === module) {
  const {server,close} = makeServer({stateFile:path.join(ROOT,'.local','last-job.json')});
  const port = Number(process.env.DCF_PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DCF_PORT 端口不合法');
  server.listen(port,'127.0.0.1',()=>console.log(`抖音评论检索已启动：http://127.0.0.1:${port}`));
  server.on('error',error=>{ console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请关闭已运行的工具或设置 DCF_PORT。` : error.message); process.exitCode=1; });
  process.on('SIGINT',()=>close().finally(()=>process.exit(0)));
  process.on('SIGTERM',()=>close().finally(()=>process.exit(0)));
}
module.exports = {makeServer,exportCSV};
