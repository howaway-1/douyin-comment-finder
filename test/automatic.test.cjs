'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {BrowserScanner,advanceComments}=require('../lib/browser.cjs');
const {ScanLedger}=require('../lib/domain.cjs');
const VIDEO='1234567890123456789';
const URL=`https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=${VIDEO}&cursor=0`;
const empty={status_code:0,comments:[],total:0,cursor:0,has_more:0};
const clear={commentPanel:true,visibleComments:0,guest:false,loginWall:false,verification:false,unavailable:false};

function fixture(extra={}) {
  let clock=0;
  const states=[],actions=[];
  const job={id:'auto-test',videoUrl:`https://www.douyin.com/video/${VIDEO}`,target:'https://www.douyin.com/user/MS4wLjABAAAAtarget123',status:'running',logs:[],maxMinutes:10,maxComments:1000,replyThreshold:100};
  const scanner=new BrowserScanner(job,value=>states.push(JSON.parse(JSON.stringify(value))),{now:()=>clock,delay:async ms=>{clock+=ms;},...extra});
  scanner.ledger=new ScanLedger(VIDEO,scanner.target,{replyThreshold:100});
  scanner.page={url:()=>job.videoUrl,evaluate:async(fn,arg)=>{if(arg){actions.push(arg);return {action:'no_panel'};} return clear;}};
  scanner.openComments=async()=>{};
  return {scanner,job,states,actions};
}

test('stalled loading retries three times and ends automatically without a continue action',async()=>{
  const {scanner,job,states}=fixture();
  let reloads=0;
  scanner.reloadVideo=async()=>{reloads++;};
  await scanner.runScan();
  assert.equal(reloads,3);
  assert.equal(job.status,'finished');
  assert.equal(job.result.complete,false);
  assert.equal(job.result.verdict,'incomplete');
  assert.match(job.message,/自动重试/);
  assert.ok(states.some(s=>s.phase==='recovering'));
  assert.ok(states.every(s=>s.status!=='waiting'));
});

test('a successful automatic reload finishes without a manual resume',async()=>{
  const {scanner,job}=fixture();
  let reloads=0;
  scanner.reloadVideo=async()=>{if(++reloads===2) scanner.ledger.ingest(URL,empty);};
  await scanner.runScan();
  assert.equal(reloads,2);
  assert.equal(job.status,'finished');
  assert.equal(job.result.verdict,'not_found');
  assert.equal(job.result.coverage.allCommentsComplete,true);
});

test('exhausted pages with a count mismatch finish once without reloading or losing matches',async()=>{
  for(const found of [false,true]) {
    const {scanner,job,actions}=fixture();
    const comments=Array.from({length:28},(_,i)=>({cid:`p${i}`,reply_comment_total:i<10?2:1,
      user:{sec_uid:found&&i===0?'MS4wLjABAAAAtarget123':'someone-else'},
      reply_comment:Array.from({length:i<10?2:1},(_,j)=>({cid:`r${i}-${j}`,user:{sec_uid:'someone-else'}}))}));
    scanner.ledger.ingest(URL,{status_code:0,total:77,cursor:28,has_more:0,comments});
    scanner.reloadVideo=async()=>assert.fail('a displayed count mismatch must never reload exhausted pages');
    await scanner.runScan();
    assert.equal(job.status,'finished');
    assert.equal(job.stopReason,'range_exhausted');
    assert.equal(job.result.coverage.pagesExhausted,true);
    assert.equal(job.result.complete,false);
    assert.equal(job.result.verdict,found?'found':'incomplete');
    assert.equal(job.result.matches.length,found?1:0);
    assert.equal(job.counts.comments,28);
    assert.equal(job.counts.replies,38);
    assert.equal(job.automatic.retryAttempt,0);
    assert.ok(actions.length>0);
    assert.ok(actions.every(action=>!action.rewind&&!action.includeReplies));
    assert.match(job.result.reason,/已读完当前返回/);
    assert.match(job.result.reason,/总数 77 条/);
  }
});

test('long scrolling without new response data does not interrupt a progressing scan',async()=>{
  const {scanner,job}=fixture();
  scanner.ledger.ingest(URL,{status_code:0,total:2,cursor:1,has_more:1,comments:[{cid:'first',reply_comment_total:0,user:{sec_uid:'other'}}]});
  let scrolls=0;
  scanner.page.evaluate=async(fn,arg)=>{
    if(!arg) return clear;
    scrolls++;
    if(scrolls===40) scanner.ledger.ingest(URL.replace('cursor=0','cursor=1'),{status_code:0,total:2,cursor:2,has_more:0,comments:[{cid:'last',reply_comment_total:0,user:{sec_uid:'other'}}]});
    return {action:'scroll',moved:true,top:scrolls*300};
  };
  scanner.reloadVideo=async()=>assert.fail('56 seconds of forward scrolling is not a loading failure');
  await scanner.runScan();
  assert.equal(scrolls,40);
  assert.equal(job.result.complete,true);
  assert.equal(job.automatic.retryAttempt,0);
});

test('scroll jitter does not postpone the retry budget indefinitely',async()=>{
  const {scanner,job}=fixture();
  let scrolls=0,reloads=0;
  scanner.page.evaluate=async(fn,arg)=>arg?{action:'scroll',moved:true,top:++scrolls%2?300:280}:clear;
  scanner.reloadVideo=async()=>{reloads++;};
  await scanner.runScan();
  assert.equal(reloads,3);
  assert.ok(scrolls<100);
  assert.equal(job.status,'finished');
  assert.match(job.message,/自动重试/);
});

test('exhausted comments check the tail and wait for identity without reloading',async()=>{
  for(const resolve of [false,true]) {
    const {scanner,job,actions}=fixture();
    scanner.target={kind:'handle',value:'target-account'};
    scanner.ledger=new ScanLedger(VIDEO,scanner.target,{replyThreshold:100});
    scanner.ledger.ingest(URL,empty);
    scanner.reloadVideo=async()=>assert.fail('an unresolved identity must not reload exhausted comments');
    let lookups=0;
    scanner.resolveIdentity=async()=>{
      lookups++;
      if(resolve&&lookups===3) scanner.ledger.setTargetIdentity({unique_id:'target-account',uid:'target-id'});
    };
    await scanner.runScan();
    assert.equal(job.status,'finished');
    assert.ok(actions.every(action=>!action.rewind&&!action.includeReplies));
    assert.equal(job.automatic.retryAttempt,0);
    assert.equal(job.result.complete,resolve);
    assert.equal(job.result.verdict,resolve?'not_found':'incomplete');
    assert.ok(lookups>=3&&lookups<=31,'identity-only waiting must remain bounded');
  }
});

test('a terminal response with a count gap does not stop before lower comments load',async()=>{
  const {scanner,job}=fixture();
  const first={cid:'first',reply_comment_total:0,user:{sec_uid:'other'}};
  scanner.ledger.ingest(URL,{status_code:0,total:2,cursor:1,has_more:0,comments:[first]});
  let scrolls=0;
  scanner.page.evaluate=async(fn,arg)=>{
    if(!arg) return clear;
    if(++scrolls===3) scanner.ledger.ingest(URL,{status_code:0,total:2,cursor:2,has_more:0,comments:[first,{cid:'lower-target',reply_comment_total:0,user:{sec_uid:'MS4wLjABAAAAtarget123'}}]});
    return {action:'scroll',moved:true,top:scrolls*300,height:400,totalHeight:1800};
  };
  scanner.reloadVideo=async()=>assert.fail('continue scrolling in place');
  await scanner.runScan();
  assert.equal(scrolls,3);
  assert.equal(job.result.complete,true);
  assert.equal(job.result.matches[0].id,'lower-target');
});

test('opening the initial work retries a transient navigation failure automatically',async()=>{
  const {scanner,job,states}=fixture();
  let navigations=0,scans=0;
  scanner.page.goto=async()=>{if(++navigations===1) throw new Error('net::ERR_CONNECTION_RESET');};
  scanner.runScan=async()=>{scans++;};
  await scanner.openVideo();
  assert.equal(navigations,2); assert.equal(scans,1);
  assert.ok(states.some(s=>s.phase==='recovering'));
  assert.notEqual(job.status,'waiting');
});

test('an unreachable initial work has a bounded automatic retry budget',async()=>{
  const {scanner}=fixture();
  let navigations=0;
  scanner.page.goto=async()=>{navigations++;throw new Error('net::ERR_CONNECTION_RESET');};
  await assert.rejects(scanner.openVideo(),/自动重试后仍无法打开/);
  assert.equal(navigations,4);
});

test('verification waits without reloading its form and automatically recovers after it clears',async()=>{
  const {scanner,job}=fixture();
  scanner.ledger.ingest(URL,empty);
  let checks=0,reloads=0,waits=0;
  scanner.page.evaluate=async()=>({...clear,verification:++checks<=2});
  scanner.delay=async()=>{waits++;assert.equal(reloads,0);assert.equal(job.status,'waiting');};
  scanner.reloadVideo=async()=>{reloads++;};
  await scanner.runScan();
  assert.equal(waits,2); assert.equal(reloads,1);
  assert.equal(job.status,'finished'); assert.equal(job.result.complete,true);
});

test('a persistent access requirement ends at the configured time limit',async()=>{
  const {scanner,job}=fixture();
  job.maxMinutes=1;
  scanner.page.evaluate=async()=>({...clear,loginWall:true});
  scanner.reloadVideo=async()=>assert.fail('must not reload an active login form');
  await scanner.runScan();
  assert.equal(job.status,'finished');
  assert.equal(job.result.complete,false);
  assert.match(job.message,/时间上限/);
  assert.match(job.result.reason,/时间上限/);
});

test('stop cancels automatic waiting immediately and cannot resume scanning', {timeout:1500},async()=>{
  let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const job={id:'stop-test',videoUrl:`https://www.douyin.com/video/${VIDEO}`,target:'https://www.douyin.com/user/MS4wLjABAAAAtarget123',status:'running',logs:[],maxMinutes:10,maxComments:1000};
  const scanner=new BrowserScanner(job,value=>{if(value.status==='waiting') release();});
  scanner.ledger=new ScanLedger(VIDEO,scanner.target,{replyThreshold:100});
  scanner.page={url:()=>job.videoUrl,evaluate:async()=>({...clear,loginWall:true})};
  scanner.reloadVideo=async()=>assert.fail('stopped scan must never reload');
  const scan=scanner.runScan();
  await waiting;
  await scanner.stop();
  await scan;
  assert.equal(scanner.wakeWait,null);
  assert.equal(job.status,'finished');
  assert.equal(scanner.runningPromise,null);
});

test('large, unknown, and still-loading primary scopes do not expand replies',async()=>{
  for(const total of [null,101,2]) {
    const {scanner,job,actions}=fixture();
    if(total!==null) scanner.ledger.ingest(URL,{status_code:0,total,cursor:20,has_more:1,comments:[{cid:'parent',text:'x',reply_comment_total:1,user:{sec_uid:'someone-else'}}]});
    scanner.delay=async()=>scanner.stop();
    await scanner.runScan();
    assert.equal(actions.length,1);
    assert.equal(actions[0].includeReplies,false);
    assert.equal(job.status,'finished');
  }
});

test('the page adapter never clicks reply controls when reply expansion is disabled',async()=>{
  let clicks=0;
  const reply={children:[],innerText:'展开 2 条回复',dataset:{},getBoundingClientRect:()=>({width:100,height:20,top:10,bottom:30}),click:()=>{clicks++;}};
  const vm=require('node:vm');
  const page={evaluate:async(fn,args)=>vm.runInNewContext(`(${fn.toString()})(args)`,{args,document:{querySelectorAll:selector=>selector.startsWith('button')?[reply]:[]},getComputedStyle:()=>({display:'block',visibility:'visible'}),innerHeight:800,Date})};
  await advanceComments(page,{includeReplies:false});
  assert.equal(clicks,0);
  await advanceComments(page,{includeReplies:true});
  assert.equal(clicks,1);
});

test('scrolling advances the primary comment pane instead of a shorter nested reply pane',async()=>{
  const vm=require('node:vm');
  const pane=(height,rows)=>({clientHeight:height,scrollHeight:2000,scrollTop:0,parentElement:null,
    getBoundingClientRect:()=>({width:300,height,top:10,bottom:height+10}),
    querySelectorAll:()=>Array(rows).fill({}),scrollBy(x,y){this.scrollTop+=y;}});
  const nested=pane(100,1),primary=pane(500,10);
  const page={evaluate:async(fn,args)=>vm.runInNewContext(`(${fn.toString()})(args)`,{args,document:{querySelectorAll:selector=>selector.startsWith('button')?[]:[nested,primary]},getComputedStyle:()=>({display:'block',visibility:'visible',overflowY:'auto'}),innerHeight:850,Date})};
  const result=await advanceComments(page,{includeReplies:false});
  assert.equal(result.action,'scroll'); assert.equal(result.rows,10);
  assert.equal(nested.scrollTop,0); assert.ok(primary.scrollTop>0);
});

for(const existing of ['comment-item','comment-list']) {
  test(`opening comments reveals an already rendered ${existing} below the viewport`,async()=>{
    const {scanner}=fixture();
    const revealed=[];
    let clicks=0;
    const locator=kind=>({
      first(){return this;},
      // Playwright visibility deliberately remains true for a rendered element
      // below the fold; only scrolling makes this fixture enter the viewport.
      isVisible:async()=>kind===existing,
      scrollIntoViewIfNeeded:async()=>{revealed.push(kind);},
      click:async()=>{clicks++;},
    });
    scanner.page={
      locator:selector=>locator(selector.match(/data-e2e="([^"]+)"/)?.[1] || selector),
      getByText:()=>locator('comment-tab'),
    };
    await BrowserScanner.prototype.openComments.call(scanner);
    assert.deepEqual(revealed,[existing]);
    assert.equal(clicks,0,'an existing list must be revealed without toggling its comment control');
  });
}

test('the page adapter reveals below-fold comment rows and ignores hidden rows',async()=>{
  const vm=require('node:vm');
  const revealed=[];
  let replyClicks=0;
  const rect=()=>({width:300,height:60,top:1000,bottom:1060});
  const row=(id,display='block')=>({id,display,parentElement:null,clientHeight:60,scrollHeight:60,
    getBoundingClientRect:rect,scrollIntoView:options=>{revealed.push({id,block:options.block});}});
  const rows=[row('first'),row('last'),row('hidden','none')];
  const reply={children:[],innerText:'展开 2 条回复',dataset:{},getBoundingClientRect:rect,
    click:()=>{replyClicks++;}};
  const page={evaluate:async(fn,args)=>vm.runInNewContext(`(${fn.toString()})(args)`,{
    args,document:{querySelectorAll:selector=>selector.startsWith('button')?[reply]:rows},
    getComputedStyle:el=>({display:el.display || 'block',visibility:'visible',overflowY:'visible'}),
    innerHeight:850,Date,
  })};
  const forward=await advanceComments(page,{includeReplies:true});
  assert.equal(forward.action,'reveal_row');
  assert.equal(forward.rows,2);
  assert.deepEqual(revealed,[{id:'last',block:'end'}]);
  const rewind=await advanceComments(page,{includeReplies:true,rewind:true});
  assert.equal(rewind.action,'reveal_row');
  assert.deepEqual(revealed.at(-1),{id:'first',block:'start'});
  assert.equal(replyClicks,0,'offscreen reply controls must not be clicked while revealing comments');
});

test('scrolling reaches the video route scroller seven ancestors above the comment list',async()=>{
  const vm=require('node:vm');
  const element=(overflowY='visible',top=10)=>({overflowY,clientHeight:600,scrollHeight:600,parentElement:null,
    getBoundingClientRect:()=>({width:800,height:600,top,bottom:top+600})});
  const list=element('visible',904);
  let ancestor=list;
  for(let i=0;i<6;i++) { ancestor.parentElement=element(); ancestor=ancestor.parentElement; }
  const route=element('auto');
  Object.assign(route,{scrollHeight:3200,scrollTop:0,querySelectorAll:()=>Array(5).fill({}),
    scrollBy(x,y){this.scrollTop+=y;}});
  ancestor.parentElement=route;
  const page={evaluate:async(fn,args)=>vm.runInNewContext(`(${fn.toString()})(args)`,{
    args,document:{querySelectorAll:selector=>selector.startsWith('[data-e2e*')?[list]:[]},
    getComputedStyle:el=>({display:'block',visibility:'visible',overflowY:el.overflowY}),
    innerHeight:850,Date,
  })};
  const result=await advanceComments(page,{includeReplies:false});
  assert.equal(result.action,'scroll');
  assert.equal(result.rows,5);
  assert.equal(result.moved,true);
  assert.ok(route.scrollTop>0,'the real scroller beyond the former five-level limit must advance');
});

test('document-backed comments scroll even when the document overflow is visible',async()=>{
  const vm=require('node:vm');
  const root={clientHeight:800,scrollHeight:2600,scrollTop:0,parentElement:null,
    getBoundingClientRect:()=>({width:1000,height:800,top:0,bottom:800}),
    querySelectorAll:()=>Array(5).fill({}),scrollBy(x,y){this.scrollTop+=y;}};
  const list={clientHeight:1000,scrollHeight:1000,parentElement:root,
    getBoundingClientRect:()=>({width:600,height:1000,top:900,bottom:1900})};
  const page={evaluate:async(fn,args)=>vm.runInNewContext(`(${fn.toString()})(args)`,{
    args,document:{scrollingElement:root,querySelectorAll:selector=>selector.startsWith('[data-e2e*')?[list]:[]},
    getComputedStyle:()=>({display:'block',visibility:'visible',overflowY:'visible'}),
    innerHeight:850,Date,
  })};
  const result=await advanceComments(page,{includeReplies:false});
  assert.equal(result.action,'scroll');
  assert.equal(result.moved,true);
  assert.ok(root.scrollTop>0);
  const rewind=await advanceComments(page,{includeReplies:false,rewind:true});
  assert.equal(rewind.action,'rewind');
  assert.equal(root.scrollTop,0);
});
