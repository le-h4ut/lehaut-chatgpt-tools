// ==UserScript==
// @name         ChatGPT Message Search (Le_Haut)
// @namespace    le_haut.chatgpt.search
// @version      1.2.0
// @description  Mobile-first full-chat search + full-history injection for reliable jumps. Independent from Full FixPack; never touches the composer.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// ==/UserScript==

(() => {
'use strict';
const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
const APP='lehaut-msg-search', PAGE_SIZE=100, MAX_PAGES=2000, MAX_RETRIES=6, BATCH=100;
if (window.__LEHAUT_MSG_SEARCH__) return; window.__LEHAUT_MSG_SEARCH__=true;
const S={id:'',title:'',loaded:false,loading:false,msgs:[],results:[],query:'',role:'all',rendered:0,token:0,lastId:''};

// ============================================================================
// FULL HISTORY INJECTOR
//
// ChatGPT's mobile UI normally asks the backend only for the newest chunk of a
// long conversation. This patch runs at document-start, intercepts that initial
// conversation request, fetches every older page, and gives React one merged
// response. It is the useful part of Full FixPack, without any composer/Markdown
// code. If Full FixPack is accidentally enabled too, the shared guard prevents a
// double patch.
// ============================================================================
(() => {
  if (PAGE.__LEHAUT_FULL_HISTORY_PATCHED__) return;
  PAGE.__LEHAUT_FULL_HISTORY_PATCHED__ = true;

  const NativeFetch = PAGE.fetch.bind(PAGE);
  const PageRequest = PAGE.Request;
  const PageResponse = PAGE.Response;
  const PageHeaders = PAGE.Headers;
  const INJECT_PAGE_SIZE = 100;
  const INJECT_MAX_PAGES = 2000;

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input?.url || '';
  }

  function isConversationInitial(url) {
    try {
      const u = new URL(url, location.origin);
      return /^\/backend-api\/conversations\/[^/]+$/.test(u.pathname) &&
             !u.searchParams.has('before');
    } catch {
      return false;
    }
  }

  function conversationId(url) {
    try {
      const pathname = new URL(url, location.origin).pathname;
      return decodeURIComponent(
        pathname.match(/^\/backend-api\/conversations\/([^/]+)$/)?.[1] || ''
      );
    } catch {
      return '';
    }
  }

  function previousCursor(payload) {
    if (!payload?.page_info?.has_previous_page) return '';
    return String(payload.page_info.start_cursor || '').trim();
  }

  function cloneHeaders(request) {
    const headers = new PageHeaders();
    try {
      for (const [key, value] of request.headers.entries()) headers.set(key, value);
    } catch (error) {
      console.warn('[LeHaut Search] FullHistory: header clone failed', error);
    }
    return headers;
  }

  async function olderPage(id, before, originalRequest) {
    const url = new URL(
      `/backend-api/conversations/${encodeURIComponent(id)}/messages`,
      location.origin
    );
    url.searchParams.set('before', before);
    url.searchParams.set('include_has_versions', 'true');
    url.searchParams.set('num_turns', String(INJECT_PAGE_SIZE));

    const req = new PageRequest(url.href, {
      method: 'GET',
      headers: cloneHeaders(originalRequest),
      credentials: originalRequest.credentials || 'include',
      cache: 'no-store',
      redirect: originalRequest.redirect || 'follow',
    });

    const response = await NativeFetch(req);
    if (!response.ok) throw new Error(`Older page HTTP ${response.status}`);
    return response.json();
  }

  function mergePages(pagesNewestToOldest) {
    const out = [];
    const seen = new Set();
    for (const page of [...pagesNewestToOldest].reverse()) {
      for (const message of page || []) {
        if (!message) continue;
        const id = String(message.id || '');
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        out.push(message);
      }
    }
    return out;
  }

  async function expand(initial, id, request) {
    if (!Array.isArray(initial?.messages)) return null;
    let before = previousCursor(initial);
    if (!before) return null;

    const pages = [initial.messages];
    const seen = new Set();
    let oldestPage = initial;
    let pageCount = 1;

    console.info('[LeHaut Search] FullHistory: expanding', id);

    while (before) {
      if (seen.has(before)) throw new Error('Pagination cursor repeated');
      seen.add(before);
      if (pageCount >= INJECT_MAX_PAGES) {
        throw new Error(`Pagination safety limit: ${INJECT_MAX_PAGES}`);
      }

      const page = await olderPage(id, before, request);
      if (!Array.isArray(page?.messages)) throw new Error('History page has no messages[]');
      if (!page.messages.length && page?.page_info?.has_previous_page) {
        throw new Error('History page is empty while has_previous_page=true');
      }

      pages.push(page.messages);
      oldestPage = page;
      pageCount++;
      before = previousCursor(page);
    }

    const messages = mergePages(pages);
    PAGE.__LEHAUT_FULL_HISTORY_LAST__ = { id, pageCount, messageCount: messages.length };

    console.info(
      '[LeHaut Search] FullHistory: ready —',
      pageCount,
      'pages,',
      messages.length,
      'messages'
    );

    return {
      ...initial,
      messages,
      page_info: {
        ...(initial.page_info || {}),
        has_previous_page: false,
        has_next_page: false,
        start_cursor:
          oldestPage?.page_info?.start_cursor ?? initial?.page_info?.start_cursor,
        end_cursor: initial?.page_info?.end_cursor,
      },
    };
  }

  PAGE.fetch = async function patchedFetch(input, init) {
    let request;
    try {
      request = new PageRequest(input, init);
    } catch {
      return NativeFetch(input, init);
    }

    const url = requestUrl(request);
    if (request.method !== 'GET' || !isConversationInitial(url)) {
      return NativeFetch(request);
    }

    const id = conversationId(url);
    if (!id) return NativeFetch(request);

    const original = await NativeFetch(request.clone());
    if (!original.ok) return original;

    let initial;
    try {
      initial = await original.clone().json();
    } catch {
      return original;
    }

    try {
      const merged = await expand(initial, id, request);
      if (!merged) return original;

      const headers = new PageHeaders(original.headers);
      headers.delete('content-length');
      headers.set('content-type', 'application/json');

      return new PageResponse(JSON.stringify(merged), {
        status: original.status,
        statusText: original.statusText,
        headers,
      });
    } catch (error) {
      // Fail-open: ChatGPT must remain usable even if OpenAI changes pagination.
      console.warn('[LeHaut Search] FullHistory injection failed', error);
      return original;
    }
  };

  console.info('[LeHaut Search] FullHistory interceptor installed');
})();
const $=n=>document.getElementById(`${APP}-${n}`), sleep=ms=>new Promise(r=>setTimeout(r,ms));
const cid=()=>{try{return new URL(location.href).pathname.match(/(?:^|\/)c\/([^/?#]+)/)?.[1]||''}catch{return''}};
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
const low=s=>String(s??'').toLocaleLowerCase();
const norm=s=>String(s??'').replace(/\u00a0/g,' ').replace(/\r\n?/g,'\n').replace(/[ \t]+/g,' ').trim();
function status(a,b='',k=''){if($('status-main'))$('status-main').textContent=a;if($('status-sub'))$('status-sub').textContent=b;if($('status'))$('status').dataset.kind=k}

async function auth(){
  const r=await PAGE.fetch('/api/auth/session',{credentials:'include',cache:'no-store',headers:{Accept:'application/json'}});
  if(!r.ok)throw Error(`Сессия ChatGPT: HTTP ${r.status}`); const x=await r.json(); if(!x?.accessToken)throw Error('В сессии нет accessToken. Обнови страницу.');
  const h={Accept:'application/json',Authorization:`Bearer ${x.accessToken}`}; if(x?.account?.id)h['ChatGPT-Account-Id']=x.account.id; return h;
}
function retry(r,n){const a=Number(r?.headers?.get?.('retry-after'));return Number.isFinite(a)&&a>0?Math.min(a*1000,60000):Math.min(1000*(2**n),15000)}
async function getJson(url,h,label){let last;for(let n=0;n<MAX_RETRIES;n++){let r;try{r=await PAGE.fetch(url,{credentials:'include',cache:'no-store',headers:h})}catch(e){last=e;await sleep(Math.min(1000*(2**n),10000));continue}if(r.ok)return r.json();last=Error(`${label}: HTTP ${r.status}`);if(r.status===429||r.status>=500){await sleep(retry(r,n));continue}throw last}throw last||Error(`${label}: ошибка запроса`)}
const cursor=x=>x?.page_info?.has_previous_page?String(x.page_info.start_cursor||'').trim():'';
function dedupe(pages){const out=[],seen=new Set();for(const page of pages)for(const m of page||[]){if(!m||typeof m!=='object')continue;const id=typeof m.id==='string'?m.id:'';if(id&&seen.has(id))continue;if(id)seen.add(id);out.push(m)}return out}
async function paged(id,h,tok){
  const u=new URL(`/backend-api/conversations/${encodeURIComponent(id)}`,location.origin);u.searchParams.set('include_has_versions','true');u.searchParams.set('num_turns',PAGE_SIZE);
  status('Загружаю всю историю…','Страница 1');const first=await getJson(u.href,h,'Первая страница');if(tok!==S.token)throw Error('__STALE__');if(!Array.isArray(first?.messages))throw Error('API не вернул messages[]');
  const pages=[first.messages],seen=new Set();let c=cursor(first),n=1;
  while(c){if(tok!==S.token)throw Error('__STALE__');if(seen.has(c))throw Error('Курсор истории повторился — поиск остановлен.');seen.add(c);if(n>=MAX_PAGES)throw Error(`Лимит ${MAX_PAGES} страниц.`);
    const p=new URL(`/backend-api/conversations/${encodeURIComponent(id)}/messages`,location.origin);p.searchParams.set('before',c);p.searchParams.set('include_has_versions','true');p.searchParams.set('num_turns',PAGE_SIZE);
    status('Загружаю всю историю…',`Страница ${n+1}`);const x=await getJson(p.href,h,`Страница ${n+1}`);if(!Array.isArray(x?.messages))throw Error(`Страница ${n+1}: нет messages[]`);if(!x.messages.length&&x?.page_info?.has_previous_page)throw Error('API заявил, что история есть, но вернул пустую страницу.');pages.push(x.messages);n++;c=cursor(x);
  }
  return {title:first?.title||'ChatGPT conversation',pages:n,messages:dedupe([...pages].reverse())};
}
function branch(d){const m=d?.mapping,cur=d?.current_node;if(!m||!cur)throw Error('Legacy API: нет mapping/current_node');const out=[],seen=new Set();let id=cur;while(id){if(seen.has(id))throw Error('Legacy mapping: цикл');seen.add(id);const node=m[id];if(!node)throw Error(`Legacy mapping: нет node ${id}`);if(node.message)out.push(node.message);id=node.parent||''}return out.reverse()}
async function legacy(id,h,tok){status('Пробую резервный API…','Legacy endpoint');const u=new URL(`/backend-api/conversation/${encodeURIComponent(id)}`,location.origin);u.searchParams.set('include_full_conversation','true');const d=await getJson(u.href,h,'Legacy API');if(tok!==S.token)throw Error('__STALE__');return{title:d?.title||'ChatGPT conversation',pages:1,messages:branch(d)}}
async function fetchAll(id,tok){const h=await auth();let e;try{return await paged(id,h,tok)}catch(x){if(x.message==='__STALE__')throw x;e=x;console.warn('[LeHaut Search] paged failed',x)}try{return await legacy(id,h,tok)}catch(x){if(x.message==='__STALE__')throw x;throw Error(`Не удалось получить полную историю.\nОсновной API: ${e?.message||e}\nРезервный API: ${x?.message||x}`)}}

function part(p){if(typeof p==='string')return p;if(!p||typeof p!=='object')return'';if(typeof p.text==='string')return p.text;const t=p.content_type||p.type;if(t==='image_asset_pointer')return'[IMAGE]';if(t==='audio_asset_pointer')return'[AUDIO]';return''}
function ctext(c){if(!c)return'';if(typeof c==='string')return c;if(Array.isArray(c.parts))return c.parts.map(part).filter(Boolean).join('\n');if(typeof c.text==='string')return c.text;if(typeof c.result==='string')return c.result;if(typeof c.summary==='string')return c.summary;return''}
function normalize(m,i){return{id:m?.id||'',role:String(m?.author?.role||'unknown').toLowerCase(),raw:i,time:Number.isFinite(m?.create_time)?new Date(m.create_time*1000).toISOString():'',type:m?.content?.content_type||null,recipient:m?.recipient||null,hidden:m?.metadata?.is_visually_hidden_from_conversation===true,text:ctext(m?.content)}}
function visible(m){return(m.role==='user'||m.role==='assistant')&&!m.hidden&&(!m.recipient||m.recipient==='all')&&(m.type==='text'||m.type==='multimodal_text')&&!!String(m.text||'').trim()}

function snippet(text,q){const s=String(text||''),needle=String(q||'').trim();if(!needle){const z=norm(s);return z.length>250?z.slice(0,250)+'…':z}const at=low(s).indexOf(low(needle));if(at<0)return snippet(s,'');const a=Math.max(0,at-115),b=Math.min(s.length,at+needle.length+115);return(a?'…':'')+s.slice(a,b).replace(/\s+/g,' ').trim()+(b<s.length?'…':'')}
function hi(text,q){const s=String(text||''),n=String(q||'').trim();if(!n)return esc(s);const sl=low(s),nl=low(n);let at=0,out='';while(true){const i=sl.indexOf(nl,at);if(i<0){out+=esc(s.slice(at));break}out+=esc(s.slice(at,i))+`<mark>${esc(s.slice(i,i+n.length))}</mark>`;at=i+n.length}return out}
const label=r=>r==='user'?'YOU':'CHATGPT';
function plural(n){const a=n%10,b=n%100;if(a===1&&b!==11)return'результат';if([2,3,4].includes(a)&&![12,13,14].includes(b))return'результата';return'результатов'}
function search(){S.query=String($('input')?.value||'').trim();S.rendered=0;const q=low(S.query);S.results=S.loaded?S.msgs.filter(m=>(S.role==='all'||m.role===S.role)&&(!q||low(m.text).includes(q))):[];render()}
function render(append=false){const list=$('results'),cnt=$('result-count');if(!list||!cnt)return;cnt.textContent=S.loaded?`${S.results.length} ${plural(S.results.length)}`:'История не загружена';if(!append){list.innerHTML='';S.rendered=0}if(!S.loaded){list.innerHTML=`<div class="${APP}-empty">Открой обычный чат и нажми поиск.</div>`;return}if(!S.results.length){list.innerHTML=`<div class="${APP}-empty">Ничего не найдено.</div>`;return}const to=Math.min(S.rendered+BATCH,S.results.length),frag=document.createDocumentFragment();for(let i=S.rendered;i<to;i++){const m=S.results[i],b=document.createElement('button');b.type='button';b.className=`${APP}-result`;b.innerHTML=`<div class="${APP}-rh"><span class="${APP}-role ${APP}-${m.role}">${label(m.role)}</span><span class="${APP}-pos">#${m.vi+1}</span></div><div class="${APP}-snip">${hi(snippet(m.text,S.query),S.query)}</div>`;b.onclick=()=>pick(i);frag.appendChild(b)}list.appendChild(frag);S.rendered=to;$('more')?.remove();if(to<S.results.length){const b=document.createElement('button');b.id=`${APP}-more`;b.className=`${APP}-more`;b.textContent=`Показать ещё (${S.results.length-to})`;b.onclick=()=>render(true);list.appendChild(b)}}

function cssEsc(v){return window.CSS?.escape?CSS.escape(v):String(v).replace(/["\\]/g,'\\$&')}
function rendered(m){if(m?.id){const id=cssEsc(m.id),x=document.querySelector(`[data-message-id="${id}"]`)||document.querySelector(`[data-message-id*="${id}"]`);if(x)return x}const p=norm(m?.text).slice(0,90);if(!p)return null;for(const x of document.querySelectorAll('article,[data-testid^="conversation-turn-"],[data-message-author-role]')){const t=norm(x.innerText||'');if(t&&(t.includes(p)||p.includes(t.slice(0,70))))return x}return null}
function flashAndCenter(e){const x=e.closest?.('article,[data-testid^="conversation-turn-"]')||e;try{x.scrollIntoView({behavior:'smooth',block:'center'})}catch{x.scrollIntoView()}x.classList.add(`${APP}-flash`);setTimeout(()=>x.classList.remove(`${APP}-flash`),2200)}
function scroller(){const turn=document.querySelector('article,[data-testid^="conversation-turn-"],[data-message-author-role]');let n=turn?.parentElement;while(n&&n!==document.body){try{const cs=getComputedStyle(n);if(n.scrollHeight>n.clientHeight+120&&(cs.overflowY==='auto'||cs.overflowY==='scroll'))return n}catch{}n=n.parentElement}return document.scrollingElement||document.documentElement}
function forceOlderLoad(){const s=scroller();try{if(s===document.scrollingElement||s===document.documentElement||s===document.body)window.scrollTo({top:0,behavior:'instant'});else s.scrollTop=0}catch{try{window.scrollTo(0,0)}catch{}}}
function jumpToast(msg){let t=document.getElementById(`${APP}-toast`);if(!t){t=document.createElement('div');t.id=`${APP}-toast`;t.style.cssText='position:fixed;left:50%;bottom:calc(26px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147483647;max-width:min(88vw,520px);padding:10px 13px;border-radius:12px;background:#202020ee;color:#fff;box-shadow:0 8px 28px #0008;font:700 12px/1.35 system-ui;text-align:center;pointer-events:none';document.documentElement.appendChild(t)}t.textContent=msg;clearTimeout(t._timer);t._timer=setTimeout(()=>t.remove(),2200)}
async function jump(m){let e=rendered(m);close();if(e){setTimeout(()=>flashAndCenter(e),50);return true}
  jumpToast('Подгружаю нужный участок чата…');
  // Usually FullHistory already made the whole thread available to React. This loop is
  // a fallback for mobile virtualization / a tab that was opened before the userscript.
  const until=Date.now()+7000;let rounds=0;
  while(Date.now()<until){e=rendered(m);if(e){flashAndCenter(e);return true}forceOlderLoad();rounds++;await sleep(rounds<8?120:220)}
  e=rendered(m);if(e){flashAndCenter(e);return true}jumpToast('Не удалось отрисовать сообщение в ленте');return false}
async function pick(i){const m=S.results[i];if(!m)return;if(await jump(m))return;open();reader(m)}
function reader(m){const r=$('reader');if(!r)return;$('reader-role').textContent=label(m.role);$('reader-index').textContent=`Сообщение ${m.vi+1} из ${S.msgs.length}`;$('reader-text').textContent=m.text;const prev=S.msgs[m.vi-1],next=S.msgs[m.vi+1],a=[];if(prev)a.push(`<div class="${APP}-ctx"><b>${label(prev.role)} · ПЕРЕД НИМ</b>${esc(snippet(prev.text,''))}</div>`);if(next)a.push(`<div class="${APP}-ctx"><b>${label(next.role)} · ПОСЛЕ НЕГО</b>${esc(snippet(next.text,''))}</div>`);$('reader-context').innerHTML=a.join('');const j=$('reader-jump');j.disabled=false;j.textContent='Показать в чате';j.onclick=async()=>{await jump(m)};$('reader-copy').onclick=async()=>{try{await navigator.clipboard.writeText(m.text);$('reader-copy').textContent='Скопировано';setTimeout(()=>{if($('reader-copy'))$('reader-copy').textContent='Копировать'},900)}catch{}};r.classList.add(`${APP}-reader-open`)}
const closeReader=()=>$('reader')?.classList.remove(`${APP}-reader-open`);

function clear(){S.id='';S.title='';S.loaded=false;S.msgs=[];S.results=[];S.rendered=0;closeReader();if($('input'))$('input').value='';render()}
async function load(force=false){const id=cid();if(!id){clear();status('Сейчас открыт не обычный чат','Нужен URL вида /c/<conversation-id>','error');return}if(!force&&S.loaded&&S.id===id){status(S.title,`${S.msgs.length} видимых сообщений`,'ok');search();return}if(S.loading)return;const tok=++S.token;S.loading=true;S.loaded=false;S.id=id;try{const x=await fetchAll(id,tok);if(tok!==S.token||cid()!==id)return;S.title=x.title;S.msgs=x.messages.map(normalize).filter(visible).map((m,vi)=>({...m,vi}));S.loaded=true;if($('title'))$('title').textContent=S.title;status(S.title,`${S.msgs.length} видимых сообщений · полная история`,'ok');search()}catch(e){if(e?.message==='__STALE__')return;console.error('[LeHaut Search]',e);S.loaded=false;S.msgs=[];S.results=[];status('Ошибка загрузки истории',e?.message||String(e),'error');render()}finally{if(tok===S.token)S.loading=false}}

function styles(){if($('styles'))return;const s=document.createElement('style');s.id=`${APP}-styles`;s.textContent=`
#${APP}-button{position:fixed;right:18px;bottom:200px;z-index:2147483600;width:50px;height:50px;border:1px solid rgba(255,255,255,.15);border-radius:16px;background:#1d1d1df2;color:#fff;box-shadow:0 10px 30px #0005;font:22px/1 system-ui;cursor:pointer;backdrop-filter:blur(10px);-webkit-tap-highlight-color:transparent}
#${APP}-overlay{position:fixed;inset:0;z-index:2147483640;display:none;background:#000a;color:#eee;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;backdrop-filter:blur(7px)}#${APP}-overlay.${APP}-open{display:flex;align-items:center;justify-content:center;padding:18px}
#${APP}-panel{position:relative;width:min(760px,96vw);height:min(820px,92dvh);display:flex;flex-direction:column;overflow:hidden;border:1px solid #ffffff1c;border-radius:20px;background:#171717;box-shadow:0 28px 90px #0008}
.${APP}-head{display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid #ffffff14}.headmain{flex:1;min-width:0}#${APP}-title{overflow:hidden;font-size:16px;font-weight:800;text-overflow:ellipsis;white-space:nowrap}.sub{color:#888;font-size:10px}.ib{width:42px;height:42px;border:0;border-radius:12px;background:#292929;color:#fff;font-size:18px}
.${APP}-search{padding:12px 14px 9px}.iw{display:flex;align-items:center;gap:9px;padding:0 13px;border:1px solid #ffffff1a;border-radius:14px;background:#0f0f0f}.mag{color:#777;font-size:18px}#${APP}-input{width:100%;min-width:0;padding:12px 0;border:0;outline:0;background:transparent;color:#fff;font-size:16px}.filters{display:flex;gap:8px;margin-top:9px}.chip{min-height:38px;padding:0 13px;border:1px solid #ffffff14;border-radius:99px;background:#242424;color:#aaa;font-weight:700}.chip.${APP}-active{border-color:#10a37f88;background:#10a37f24;color:#8ce5cb}
#${APP}-status{margin:0 14px 7px;padding:8px 10px;border-radius:11px;background:#202020}#${APP}-status[data-kind=ok]{background:#10a37f1b}#${APP}-status[data-kind=error]{background:#dc262622}#${APP}-status-main{overflow:hidden;font-size:12px;font-weight:750;text-overflow:ellipsis;white-space:nowrap}#${APP}-status-sub{overflow:hidden;margin-top:2px;color:#888;font-size:10px;text-overflow:ellipsis;white-space:nowrap}#${APP}-result-count{padding:2px 16px 8px;color:#888;font-size:11px;font-weight:700}
#${APP}-results{flex:1;min-height:0;overflow-y:auto;padding:0 10px calc(14px + env(safe-area-inset-bottom,0px));overscroll-behavior:contain}. ${APP}-x{}
.${APP}-result{width:100%;display:block;margin:0 0 7px;padding:12px;border:1px solid transparent;border-radius:13px;background:#202020;color:#eee;text-align:left}. ${APP}-result:active{background:#292929}. ${APP}-rh{display:flex;justify-content:space-between;gap:8px;margin-bottom:7px}. ${APP}-role{font-size:10px;font-weight:900;letter-spacing:.5px}. ${APP}-user{color:#8ce5cb}. ${APP}-assistant{color:#c3adff}. ${APP}-pos{color:#666;font-size:10px}. ${APP}-snip{display:-webkit-box;overflow:hidden;color:#d6d6d6;font-size:13px;line-height:1.45;-webkit-box-orient:vertical;-webkit-line-clamp:4}. ${APP}-snip mark{padding:0 1px;border-radius:3px;background:#765b12;color:#fff1a8}. ${APP}-empty{display:grid;min-height:180px;place-items:center;padding:22px;color:#777;font-size:13px;text-align:center}. ${APP}-more{width:100%;min-height:46px;border:1px solid #ffffff14;border-radius:13px;background:#242424;color:#ddd;font-weight:750}
#${APP}-reader{position:absolute;inset:0;z-index:5;display:none;flex-direction:column;background:#171717}#${APP}-reader.${APP}-reader-open{display:flex}.rh2{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #ffffff14}.rht{flex:1;min-width:0}#${APP}-reader-role{font-size:13px;font-weight:900}#${APP}-reader-index{color:#777;font-size:10px}.rs{flex:1;min-height:0;overflow:auto;padding:14px}#${APP}-reader-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.55 ui-monospace,monospace}. ${APP}-ctx{margin-top:8px;padding:10px;border-radius:10px;background:#202020;color:#aaa;font-size:11px;line-height:1.4}. ${APP}-ctx b{display:block;margin-bottom:4px;color:#777}.ra{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid #ffffff14}.act{min-height:46px;border:0;border-radius:12px;background:#2b2b2b;color:#fff;font-weight:750}.act:disabled{opacity:.45}
.${APP}-flash{animation:${APP}-flash 2.2s ease-out!important}@keyframes ${APP}-flash{0%,30%{outline:3px solid #10a37ff2;outline-offset:7px;background:#10a37f20}100%{outline:3px solid transparent;outline-offset:12px}}
@media(max-width:720px){#${APP}-button{right:12px;bottom:calc(161px + env(safe-area-inset-bottom,0px))}#${APP}-overlay.${APP}-open{padding:0;align-items:stretch;justify-content:stretch}#${APP}-panel{width:100%;height:100dvh;max-width:none;max-height:none;border:0;border-radius:0;box-shadow:none}.${APP}-head{padding-top:max(12px,env(safe-area-inset-top,0px))}}
`;document.head.appendChild(s)}
function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}}
function ui(){if(!document.body||$('button'))return;styles();const b=document.createElement('button');b.id=`${APP}-button`;b.type='button';b.textContent='🔎';b.title='Поиск по всему чату';const o=document.createElement('div');o.id=`${APP}-overlay`;o.innerHTML=`<div id="${APP}-panel"><div class="${APP}-head"><div class="headmain"><div id="${APP}-title">Поиск по чату</div><div class="sub">Вся история, а не только сообщения на экране</div></div><button id="${APP}-refresh" class="ib" type="button">↻</button><button id="${APP}-close" class="ib" type="button">×</button></div><div class="${APP}-search"><div class="iw"><span class="mag">⌕</span><input id="${APP}-input" type="search" inputmode="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Найти сообщение…"></div><div class="filters"><button class="chip ${APP}-active" data-role="all">Все</button><button class="chip" data-role="user">Мои</button><button class="chip" data-role="assistant">ChatGPT</button></div></div><div id="${APP}-status"><div id="${APP}-status-main">История ещё не загружена</div><div id="${APP}-status-sub">Открой поиск — скрипт сам загрузит текущий чат</div></div><div id="${APP}-result-count">История не загружена</div><div id="${APP}-results"></div><div id="${APP}-reader"><div class="rh2"><button id="${APP}-reader-back" class="ib" type="button">←</button><div class="rht"><div id="${APP}-reader-role"></div><div id="${APP}-reader-index"></div></div></div><div class="rs"><pre id="${APP}-reader-text"></pre><div id="${APP}-reader-context"></div></div><div class="ra"><button id="${APP}-reader-copy" class="act">Копировать</button><button id="${APP}-reader-jump" class="act">Показать в чате</button></div></div></div>`;document.body.append(b,o);b.onclick=open;$('close').onclick=close;$('refresh').onclick=()=>load(true);$('reader-back').onclick=closeReader;$('input').addEventListener('input',debounce(search,90));o.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{o.querySelectorAll('.chip').forEach(x=>x.classList.remove(`${APP}-active`));c.classList.add(`${APP}-active`);S.role=c.dataset.role||'all';search()});document.addEventListener('keydown',e=>{if(e.key==='Escape'){if($('reader')?.classList.contains(`${APP}-reader-open`))closeReader();else if(o.classList.contains(`${APP}-open`))close()}})}
function open(){$('overlay')?.classList.add(`${APP}-open`);closeReader();const id=cid();if(!id){clear();status('Сейчас открыт не обычный чат','Нужен URL вида /c/<conversation-id>','error');return}if(!S.loaded||S.id!==id)load();else{status(S.title,`${S.msgs.length} видимых сообщений`,'ok');search()}setTimeout(()=>$('input')?.focus(),80)}
function close(){$('overlay')?.classList.remove(`${APP}-open`);closeReader();try{$('input')?.blur()}catch{}}
function route(){const id=cid();if(id===S.lastId)return;S.lastId=id;S.token++;if(S.id!==id){clear();if($('overlay')?.classList.contains(`${APP}-open`)){if(id)load();else status('Сейчас открыт не обычный чат','Нужен URL вида /c/<conversation-id>','error')}}}
S.lastId=cid();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ui,{once:true});else ui();new MutationObserver(()=>{if(!$('button'))ui();route()}).observe(document.documentElement,{childList:true,subtree:true});setInterval(route,900);window.addEventListener('popstate',route);console.info('[LeHaut Search] v1.2 loaded · FullHistory + search · composer untouched');
})();
