const DOW=['日','月','火','水','木','金','土'];
let periodKey='',currentDate='',loggedUser='',isAdmin=false;
const $=id=>document.getElementById(id);
// 【セキュリティ】HTMLに埋め込む文字列は必ずこの関数を通す（名前・備考・時刻など、他人が入力しうる値のXSS対策）
function esc(s){
  return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// 【セキュリティ】時刻は「HH:MM」形式のものだけ通す
function safeTime(s){return (typeof s==='string'&&/^([01]?\d|2[0-3]):[0-5]\d$/.test(s))?s:'';}
// スマホでパスワード欄などにキーボードが出ている状態だと、ボタンの1回目のタップが
// 「キーボードを閉じるだけ」で終わってしまい、クリックが発生しないことがある。
// touchendでも同じ処理を確実に実行することで、1回のタップで反応するようにする。
function bindTap(el,handler){
  let touched=false;
  el.addEventListener('touchend',e=>{touched=true;e.preventDefault();handler();});
  el.addEventListener('click',()=>{if(touched){touched=false;return}handler();});
}
const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'),fmt=d=>d.getMonth()+1+'/'+d.getDate();

/* ▼▼▼ 日本の祝日を自動計算する処理 ▼▼▼ */
// 移動祝日（第n月曜）の日付を求める
function nthWeekdayOfMonth(year,month,weekday,n){
  let count=0;
  for(let day=1;day<=31;day++){
    const d=new Date(year,month-1,day);
    if(d.getMonth()!==month-1)break;
    if(d.getDay()===weekday){count++;if(count===n)return day;}
  }
  return null;
}
// 春分の日・秋分の日（1980～2099年で有効な近似式）
function shunbunDay(year){return Math.floor(20.8431+0.242194*(year-1980)-Math.floor((year-1980)/4));}
function shuubunDay(year){return Math.floor(23.2488+0.242194*(year-1980)-Math.floor((year-1980)/4));}
function baseHolidaysOfYear(year){
  const h={};
  const add=(m,d,name)=>{if(d)h[`${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`]=name;};
  add(1,1,'元日');
  add(1,nthWeekdayOfMonth(year,1,1,2),'成人の日');
  add(2,11,'建国記念の日');
  add(2,23,'天皇誕生日');
  add(3,shunbunDay(year),'春分の日');
  add(4,29,'昭和の日');
  add(5,3,'憲法記念日');
  add(5,4,'みどりの日');
  add(5,5,'こどもの日');
  add(7,nthWeekdayOfMonth(year,7,1,3),'海の日');
  add(8,11,'山の日');
  add(9,nthWeekdayOfMonth(year,9,1,3),'敬老の日');
  add(9,shuubunDay(year),'秋分の日');
  add(10,nthWeekdayOfMonth(year,10,1,2),'スポーツの日');
  add(11,3,'文化の日');
  add(11,23,'勤労感謝の日');
  return h;
}
// 振替休日・国民の休日も含めて祝日マップを作成
function buildHolidayMap(startYear,endYear){
  let h={};
  for(let y=startYear;y<=endYear;y++)h={...h,...baseHolidaysOfYear(y)};
  // 振替休日：祝日が日曜のとき、直後の「祝日でない日」を休日にする
  let extra={};
  Object.keys(h).sort().forEach(dstr=>{
    const d=new Date(dstr+'T00:00:00');
    if(d.getDay()===0){
      let nd=new Date(d);
      do{nd.setDate(nd.getDate()+1);}while(h[iso(nd)]||extra[iso(nd)]);
      extra[iso(nd)]='振替休日';
    }
  });
  h={...h,...extra};
  // 国民の休日：祝日と祝日に挟まれた平日（日曜以外）を休日にする
  const holidaySet=new Set(Object.keys(h));
  let extra2={};
  Object.keys(h).sort().forEach(dstr=>{
    const d=new Date(dstr+'T00:00:00');
    const between=new Date(d);between.setDate(between.getDate()+1);
    const next=new Date(d);next.setDate(next.getDate()+2);
    if(holidaySet.has(iso(next))&&!holidaySet.has(iso(between))&&between.getDay()!==0){
      extra2[iso(between)]='国民の休日';
    }
  });
  return {...h,...extra2};
}
// アプリで扱う期間（前後数か月）をカバーできるよう、前後の年も含めて計算しておく
const HOLIDAY_MAP=buildHolidayMap(new Date().getFullYear()-1,new Date().getFullYear()+3);
function holidayName(d){return HOLIDAY_MAP[iso(d)]||null;}
/* ▲▲▲ 祝日計算ここまで ▲▲▲ */

const API_URL = 'https://script.google.com/macros/s/AKfycbwB6hFzuiXYeWvN4ah8jKQrthn_-ilwb11BP0qa2mc-mubyZt0yznmBRUjUDzFMnZzH/exec';

let authToken='';
// サーバーとの通信はすべてここを通す。ログイン後は自動でトークンを付ける。
// Googleの窓口は、サーバーの処理が1秒前後で終わっていても、返事を返すまでに数十秒止まることがある（Google側の転送の遅れ）。
// 読み取り系・ログインは、長く待たずに20秒で見切って、最大3回まで自動でやり直す方が、結果的に早くつながる。
// （書き込み系は、古いデータが後から上書きされる心配があるので、やり直さず40秒待つ）
window.onApiRetry=null;
async function api(action,payload){
  const retryable=(action==='init'||action==='login'||action==='getMany');
  const retries=retryable?2:0;
  const timeoutMs=retryable?20000:40000;
  for(let attempt=0;;attempt++){
    try{return await apiOnce(action,payload,timeoutMs);}
    catch(e){
      if(e.server||attempt>=retries)throw e;
      if(window.onApiRetry)window.onApiRetry(attempt+2);
      await new Promise(r=>setTimeout(r,800));
    }
  }
}
async function apiOnce(action,payload,timeoutMs){
  const ctrl=new AbortController();
  const timer=action==='ocr'?null:setTimeout(()=>ctrl.abort(),timeoutMs||40000); // 指定時間で見切る（OCRのみ無制限）
  try{
    const res=await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'text/plain'}, // プリフライトを避けるためtext/plainで送る
      body:JSON.stringify(Object.assign({action,token:authToken},payload||{})),
      signal:ctrl.signal
    });
    if(!res.ok)throw new Error('通信エラー: '+res.status);
    const raw=await res.text();
    let j;
    try{j=JSON.parse(raw);}catch(_){throw new Error('サーバーの応答が不正です（Apps Scriptのデプロイ更新・権限承認を確認してください）: '+raw.slice(0,80));}
    if(j.error){
      if(j.code==='auth'&&authToken){alert(j.error);location.reload();}
      const err=new Error(j.error);err.server=true;throw err;
    }
    return j;
  }catch(e){
    if(e&&e.name==='AbortError')throw new Error('サーバーの応答がありませんでした（時間切れ）');
    throw e;
  }finally{if(timer)clearTimeout(timer);}
}
// 用紙の読み取り。
// サーバーの処理に時間がかかると、処理は成功していても返事がこちらに届かず「通信エラー404」になることがある。
// そのため、読み取りごとに受付番号（jobId）をつけて送り、返事が届かなかったときは
// サーバーに一時保存された結果を数秒おきに取りに行く。
function newJobId(){
  const s=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():(Date.now().toString(36)+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2));
  return s.replace(/[^A-Za-z0-9_-]/g,'');
}
async function pollOcrResult(jobId){
  const until=Date.now()+120000; // 最長2分待つ
  while(Date.now()<until){
    await new Promise(r=>setTimeout(r,4000));
    try{
      const j=await apiOnce('ocrResult',{jobId},20000);
      if(j.status==='done')return j.result;
      if(j.status==='error'){const err=new Error(j.message||'読み取りに失敗しました');err.server=true;throw err;}
      // status==='pending'：まだ処理中なので、もう一度待つ
    }catch(e){
      if(e&&e.server)throw e; // サーバーが返した明確なエラーはそのまま伝える
      // 通信エラーは一時的なものとして、そのまま待ち続ける
    }
  }
  throw new Error('読み取りの結果を受け取れませんでした（時間切れ）');
}
async function apiOcr(base64,dateList){
  const jobId=newJobId();
  try{
    const j=await api('ocr',{image:base64,dates:dateList,jobId});
    return j.result; // {statuses:{iso:'abs'|'pref'|'none'}, times:{iso:{from,to}}, note:string}
  }catch(e){
    if(e&&e.server)throw e; // サーバーが「失敗した」と返したときは、そのままエラーにする
    return await pollOcrResult(jobId); // 返事が届かなかっただけなら、結果を取りに行く
  }
}

function names(){return cachedNames}
function data(){return periodDataCache[periodKey]||{}}
// 保存は「ログイン中の本人の分だけ」をサーバーに送る（他の人のデータには触れない）
function save(){
  const d=data();periodDataCache[periodKey]=d;
  return api('saveMine',{period:periodKey,entry:ensure(d,loggedUser)});
}
function ensure(d,n){d[n]??={status:{},time:{},note:''};d[n].note??='';return d[n]}

let cachedNames=[],cachedDeadlines={},periodDataCache={},configured=false;

async function loadConfig(){
  const v=await api('init');
  cachedNames=v.names||[];configured=!!v.configured;
}
// 前回取得したスタッフ名の一覧をスマホに覚えさせ、次回はサーバーの返事を待たずにログイン画面を出す。
// （パスワードは一切保存しない。保存するのは名前の一覧だけ）
const CFG_CACHE_KEY='cfgCache';
function readCfgCache(){
  try{
    const c=JSON.parse(localStorage.getItem(CFG_CACHE_KEY)||'null');
    if(c&&c.configured&&Array.isArray(c.names)&&c.names.length)return c;
  }catch(e){}
  return null;
}
function writeCfgCache(){
  try{
    if(configured&&cachedNames.length)localStorage.setItem(CFG_CACHE_KEY,JSON.stringify({names:cachedNames,configured:true}));
    else localStorage.removeItem(CFG_CACHE_KEY);
  }catch(e){}
}
async function saveDeadlines(dl){
  await api('setDeadlines',{deadlines:dl});
  cachedDeadlines=dl;
}
function deadlineFor(key){return cachedDeadlines[key]||'';}
function isDeadlinePassed(key){
  const dl=cachedDeadlines[key];
  if(!dl)return false;
  return new Date()>new Date(dl+'T23:59:59');
}
async function loadPeriodData(key){
  if(periodDataCache[key])return periodDataCache[key];
  try{
    const v=(await api('getMany',{keys:['period:'+key]})).values;
    periodDataCache[key]=v['period:'+key]?JSON.parse(v['period:'+key]):{};
  }catch(e){console.error(e);periodDataCache[key]={};}
  return periodDataCache[key];
}
// ログイン直後に、対象期間のデータと締切設定をまとめて取得する
function preloadKeys(){
  return [...[...period.options].map(o=>'period:'+o.value),'config:deadlines'];
}
function applyPreload(v){
  cachedDeadlines=v['config:deadlines']?JSON.parse(v['config:deadlines']):{};
  [...period.options].map(o=>o.value).forEach(k=>{
    const raw=v['period:'+k];
    periodDataCache[k]=raw?JSON.parse(raw):{};
  });
}
async function preloadPeriods(){
  applyPreload((await api('getMany',{keys:preloadKeys()})).values);
}
// ログイン中の待ち時間表示
function showWait(el,on){
  el.style.color=on?'#666':'';
  el.textContent=on?'サーバーに接続しています。時間がかかる場合があります（最大1分ほど）':'';
}


function dates(){
  const [y,m,day]=periodKey.split('-').map(Number);
  const s=new Date(y,m-1,day),e=new Date(y,m,15),out=[];
  for(let d=new Date(s);d<=e;d.setDate(d.getDate()+1))out.push(new Date(d));
  return out;
}
function makePeriods(){
  const now=new Date(),base=now.getDate()>=16?new Date(now.getFullYear(),now.getMonth(),16):new Date(now.getFullYear(),now.getMonth()-1,16);
  const arr=[0,1,2].map(i=>new Date(base.getFullYear(),base.getMonth()+i,16));
  period.innerHTML=arr.map(s=>{
    const e=new Date(s.getFullYear(),s.getMonth()+1,15);
    return `<option value="${iso(s)}">${s.getFullYear()}/${s.getMonth()+1}/16 ～ ${e.getFullYear()}/${e.getMonth()+1}/15</option>`;
  }).join('');
  periodKey=iso(arr[1]);period.value=periodKey;
}
function timeSel(k,type,v){
  let [vh,vm]=(v||'').split(':'),h='<option value="">時</option>';
  for(let i=8;i<=21;i++){let x=String(i).padStart(2,'0');h+=`<option ${vh===x?'selected':''} value="${x}">${x}</option>`}
  let m='<option value="">分</option>';
  ['00','15','30','45'].forEach(x=>m+=`<option ${vm===x?'selected':''} value="${x}">${x}</option>`);
  return `<div class="time-selects"><select data-k="${k}" data-t="${type}" data-p="h">${h}</select><select data-k="${k}" data-t="${type}" data-p="m">${m}</select></div>`;
}
function renderInputCalendar(){
  const d=data(),p=ensure(d,loggedUser);
  inputCalendar.innerHTML=dates().map(x=>{
    const k=iso(x),s=p.status[k]||'none',l={none:'未設定',abs:'絶対休み',pref:'できれば休み',off:'有給休暇'}[s];
    const hn=holidayName(x);
    return `<div class="day ${x.getDay()==0?'sun':''} ${x.getDay()==6?'sat':''} ${hn?'holiday':''}">
      <div class="date">${fmt(x)}</div><div class="dow">${DOW[x.getDay()]}</div>
      ${hn?`<span class="holiday-name" title="${hn}">${hn}</span>`:''}
      <span class="badge ${s}">${l}</span><button onclick="openModal('${k}')"></button>
    </div>`;
  }).join('');
}
function renderInput(){
  const passed=isDeadlinePassed(periodKey),dl=deadlineFor(periodKey);
  deadlineNotice.style.display=passed?'block':'none';
  inputFields.style.display=passed?'none':'block';
  deadlineInfo.textContent=(dl&&!passed)?('入力締切：'+dl.replace(/-/g,'/')+'（23:59まで）'):'';
  if(passed)return;
  const d=data(),p=ensure(d,loggedUser);
  renderInputCalendar();
  timeList.innerHTML=dates().map(x=>{
    const k=iso(x),t=p.time[k]||{},hn=holidayName(x);
    return `<div class="time-row"><span>${fmt(x)}<br>(${DOW[x.getDay()]})${hn?`<br><span style="color:#e67e22;font-size:10px;font-weight:700">(祝)</span>`:''}</span>${timeSel(k,'from',t.from)}${timeSel(k,'to',t.to)}</div>`;
  }).join('');
  noteInput.value=p.note||'';
}
function openModal(k){
  currentDate=k;const d=new Date(k+'T00:00:00'),p=ensure(data(),loggedUser),s=p.status[k]||'none',hn=holidayName(d);
  modalTitle.innerHTML=`${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}（${DOW[d.getDay()]}）${hn?`<span style="display:block;font-size:13px;color:#e67e22;font-weight:700;margin-top:2px">${hn}</span>`:''}`;
  modalPerson.textContent='入力者：'+loggedUser;
  document.querySelectorAll('.opt').forEach(b=>b.classList.toggle('selected',b.dataset.status===s));
  modal.classList.add('open');
}
document.querySelectorAll('.opt').forEach(b=>b.onclick=async()=>{
  if(!isAdmin&&isDeadlinePassed(periodKey)){modal.classList.remove('open');alert('入力締切を過ぎたため変更できません。');renderInput();return;}
  const d=data(),p=ensure(d,loggedUser);p.status[currentDate]=b.dataset.status;
  modal.classList.remove('open');renderInputCalendar();
  try{await save();}catch(e){console.error('保存に失敗しました',e);alert(e.server?e.message:'保存に失敗しました。通信環境を確認してもう一度お試しください。');}
});
closeModal.onclick=()=>modal.classList.remove('open');

function renderShare(){
  const d=data();
  shareCalendar.innerHTML=dates().map(x=>{
    const k=iso(x),a=[],p=[],o=[];
    Object.entries(d).forEach(([n,v])=>{if(v.status?.[k]=='abs')a.push(n);if(v.status?.[k]=='pref')p.push(n);if(v.status?.[k]=='off')o.push(n)});
    const hn=holidayName(x);
    return `<div class="day ${x.getDay()==0?'sun':''} ${x.getDay()==6?'sat':''} ${hn?'holiday':''}">
      <div class="date">${fmt(x)}</div><div class="dow">${DOW[x.getDay()]}</div>
      ${hn?`<span class="holiday-name" title="${hn}">${hn}</span>`:''}
      <span class="badge ${a.length?'abs':'none'}">${a.length?'🔴 '+a.length+'人':'－'}</span>
      <span class="badge ${p.length?'pref':'none'}">${p.length?'🟡 '+p.length+'人':'－'}</span>
      <span class="badge ${o.length?'off':'none'}">${o.length?'🔵 '+o.length+'人':'－'}</span>
      <button onclick="shareDetail('${k}')"></button>
    </div>`;
  }).join('');
}
function shareDetail(k){
  const d=data(),a=[],p=[],o=[];Object.entries(d).forEach(([n,v])=>{if(v.status?.[k]=='abs')a.push(n);if(v.status?.[k]=='pref')p.push(n);if(v.status?.[k]=='off')o.push(n)});
  const x=new Date(k+'T00:00:00');
  const j=arr=>arr.map(esc).join(' ')||'なし';
  shareDetailEl.innerHTML=`<h2>${fmt(x)}（${DOW[x.getDay()]}）</h2><b>🔴 絶対休み：${a.length}人</b><div class="people">${j(a)}</div><br><b>🟡 できれば休み：${p.length}人</b><div class="people">${j(p)}</div><br><b>🔵 有給休暇：${o.length}人</b><div class="people">${j(o)}</div>`;
}
const shareDetailEl=$('shareDetail');

function renderAdmin(){
  const d=data();
  adminStaff.innerHTML=names().map((n,i)=>{
    const p=ensure(d,n);
    const rows=dates().map(x=>{
      const k=iso(x),s=p.status[k]||'none';
      const sl={none:'―',abs:'🔴 絶対休み',pref:'🟡 できれば休み',off:'🔵 有給休暇'}[s];
      const t=p.time[k]||{},tf=safeTime(t.from),tt=safeTime(t.to),tm=(tf||tt)?(tf||'指定なし')+'～'+(tt||'指定なし'):'―';
      return `<div class="admin-row"><span>${fmt(x)}(${DOW[x.getDay()]})</span><span>${sl}</span><span>${tm}</span></div>`;
    }).join('');
    const noteHtml=p.note?`<p class="small"><b>備考：</b>${esc(p.note).replace(/\n/g,'<br>')}</p>`:'';
    return `<div class="staff-card"><div class="staff-head" onclick="toggleStaff('s${i}')">${esc(n)}　▾</div><div class="staff-body" id="s${i}">
      <div class="admin-row"><b>日付</b><b>休み希望</b><b>勤務可能時間</b></div>${rows}${noteHtml}</div></div>`;
  }).join('');
}
function toggleStaff(id){const e=$(id);e.style.display=e.style.display==='none'?'block':'none'}

function exportColumns(){
  // 前半（16日～月末）は常に16列分（16～31日）確保し、実際の月末が31日未満の場合は
  // 空白列（null）で埋めて後半（1日～15日）の位置を貼り付け先シートと揃える。
  const ds=dates(),startMonth=ds[0].getMonth();
  const firstSeg=ds.filter(x=>x.getMonth()===startMonth);
  const secondSeg=ds.filter(x=>x.getMonth()!==startMonth);
  while(firstSeg.length<16)firstSeg.push(null);
  return [...firstSeg,...secondSeg];
}
function exportExcel(){
  const d=data(),cols=exportColumns(),aoa=[],timeCells=[]; // timeCells: [row, col] 数値として書式設定する対象
  let row=0;
  names().forEach(n=>{
    const p=ensure(d,n);
    aoa.push([n,...cols.map(x=>x?fmt(x):'')]); row++;
    aoa.push([n,...cols.map(x=>x?DOW[x.getDay()]:'')]); row++;
    aoa.push([n,...cols.map((x,i)=>{
      if(!x)return '';
      const k=iso(x),s=p.status[k]||'none',t=p.time[k]||{};
      if(s==='abs')return '定';
      if(s==='pref')return '休';
      if(s==='off')return '有';
      if(safeTime(t.from)){timeCells.push([row,i+1]);return Number(t.from.replace(':',''));}
      return '';
    })]); row++;
    aoa.push([n,...cols.map((x,i)=>{
      if(!x)return '';
      const k=iso(x),s=p.status[k]||'none',t=p.time[k]||{};
      if(s==='abs'||s==='pref'||s==='off')return '';
      if(safeTime(t.to)){timeCells.push([row,i+1]);return Number(t.to.replace(':',''));}
      return '';
    })]); row++;
    if(p.note){aoa.push([n+'（備考）',p.note]); row++;}
    aoa.push([]); row++;
  });
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=[{wch:14},...cols.map(()=>({wch:8}))];
  // 出退勤の時刻セルは数値として保存しつつ、0900のような4桁ゼロ埋め表示にする
  timeCells.forEach(([r,c])=>{
    const addr=XLSX.utils.encode_cell({r,c});
    if(ws[addr])ws[addr].z='0000';
  });
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'シフト希望');
  XLSX.writeFile(wb,`シフト希望_${periodKey}.xlsx`);
}
exportBtn.onclick=exportExcel;

function renderAll(){
  if(!isAdmin){renderInput();renderShare()}else renderAdmin();
}
period.onchange=async()=>{periodKey=period.value;await loadPeriodData(periodKey);renderAll()};

saveBtn.onclick=async()=>{
  if(isDeadlinePassed(periodKey)){alert('入力締切を過ぎたため保存できません。');renderInput();return;}
  const d=data(),p=ensure(d,loggedUser),tmp={};
  document.querySelectorAll('[data-k][data-t]').forEach(e=>{
    tmp[e.dataset.k]??={from:{},to:{}};
    tmp[e.dataset.k][e.dataset.t][e.dataset.p]=e.value;
  });
  Object.entries(tmp).forEach(([k,v])=>{
    const from=v.from.h&&v.from.m?v.from.h+':'+v.from.m:'',to=v.to.h&&v.to.m?v.to.h+':'+v.to.m:'';
    if(from||to)p.time[k]={from,to};else delete p.time[k];
  });
  p.note=noteInput.value;
  saveBtn.disabled=true;saveMsg.textContent='保存中…';
  try{
    await save();
    saveMsg.textContent='保存しました';setTimeout(()=>saveMsg.textContent='',1500);renderAll();
  }catch(e){
    console.error('保存に失敗しました',e);saveMsg.textContent=e.server?e.message:'保存に失敗しました。もう一度お試しください。';
  }finally{saveBtn.disabled=false;}
};

// ▼▼▼ 用紙の写真からの自動読み込み（OCR） ▼▼▼
ocrBtn.onclick=()=>ocrFileInput.click();
ocrFileInput.onchange=async()=>{
  const file=ocrFileInput.files[0];
  if(!file)return;
  ocrFileInput.value='';
  if(!/^image\//.test(file.type)){alert('画像ファイルを選んでください。');return;}
  if(isDeadlinePassed(periodKey)){alert('入力締切を過ぎたため読み込めません。');return;}
  ocrBtn.disabled=true;ocrMsg.style.cssText='';ocrMsg.textContent='画像を処理中…';
  try{
    const base64=await resizeAndEncodeImage(file);
    ocrMsg.style.cssText='font-size:14px;color:#d00';
    ocrMsg.textContent='用紙を読み取っています…（すごく時間がかかる場合があります）';
    const ds=dates().map(iso);
    const result=await apiOcr(base64,ds);
    applyOcrResult(result);
    ocrMsg.style.cssText='';
    ocrMsg.textContent='読み込みました。内容を確認して保存してください。';
    setTimeout(()=>{ocrMsg.textContent='';},4000);
  }catch(e){
    console.error('読み取りに失敗しました',e);
    ocrMsg.style.cssText='';ocrMsg.textContent='';
    const em=(e&&e.message?e.message:String(e));
    const hint=/404|時間切れ/.test(em)?'\n（サーバーが混み合って時間がかかりすぎた可能性があります。少し時間をおいてお試しください）':'';
    alert('読み取りに失敗しました。\n原因: '+em+hint+'\n\nもう一度お試しいただくか、手入力をお願いします。');
  }finally{
    ocrBtn.disabled=false;
  }
};
// スマホ写真は容量が大きいため、送信前に縮小してJPEGに変換する
function resizeAndEncodeImage(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('画像の読み込みに失敗しました'));
    reader.onload=()=>{
      const img=new Image();
      img.onerror=()=>reject(new Error('画像の読み込みに失敗しました'));
      img.onload=()=>{
        const maxW=1600,scale=Math.min(1,maxW/img.width);
        const canvas=document.createElement('canvas');
        canvas.width=Math.round(img.width*scale);
        canvas.height=Math.round(img.height*scale);
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        resolve(canvas.toDataURL('image/jpeg',0.85).split(',')[1]);
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}
// 読み取り結果（{statuses,times,note}）を、今ログイン中のスタッフの入力欄に反映する。
// この時点ではまだサーバーには保存しない（本人が確認して「保存」を押すまでは反映のみ）。
function applyOcrResult(result){
  const d=data(),p=ensure(d,loggedUser);
  // 【セキュリティ】読み取り結果は信用せず、現在の対象期間の日付・決まった形式の値だけを反映する
  const valid=new Set(dates().map(iso));
  if(result&&result.statuses){
    Object.entries(result.statuses).forEach(([k,v])=>{
      if(!valid.has(k))return;
      if(v==='abs'||v==='pref'||v==='off')p.status[k]=v;else delete p.status[k];
    });
  }
  if(result&&result.times){
    Object.entries(result.times).forEach(([k,v])=>{
      if(!valid.has(k)||!v)return;
      const from=safeTime(v.from),to=safeTime(v.to);
      if(from||to)p.time[k]={from,to};
    });
  }
  if(result&&typeof result.note==='string'&&result.note.trim()){
    p.note=result.note.trim().slice(0,500);
  }
  renderInput();
}
// ▲▲▲ 用紙の写真からの自動読み込み ここまで ▲▲▲

ocrHelpToggle.onclick=()=>{
  const open=ocrHelpText.style.display!=='none';
  ocrHelpText.style.display=open?'none':'block';
  ocrHelpToggle.textContent=(open?'▸ ':'▾ ')+'使い方の説明を見る';
};

tabInput.onclick=()=>{inputView.style.display='block';shareView.style.display='none';tabInput.classList.add('active');tabShare.classList.remove('active')};
tabShare.onclick=()=>{inputView.style.display='none';shareView.style.display='block';tabInput.classList.remove('active');tabShare.classList.add('active');renderShare()};

function openChoice(){
  loginOverlay.style.display='flex';firstSetup.style.display='none';loginChoice.style.display='block';
  staffLoginBox.style.display='none';adminLoginBox.style.display='none';
}
function fillStaffNames(prefer){
  staffNameLogin.innerHTML=names().map(n=>`<option>${esc(n)}</option>`).join('');
  const lastName=localStorage.getItem('lastStaffName');
  if(prefer&&names().includes(prefer))staffNameLogin.value=prefer;
  else if(lastName&&names().includes(lastName))staffNameLogin.value=lastName;
}
function showStaffLogin(){
  loginChoice.style.display='none';staffLoginBox.style.display='block';adminLoginBox.style.display='none';
  fillStaffNames(null);
}
function showAdminLogin(){loginChoice.style.display='none';staffLoginBox.style.display='none';adminLoginBox.style.display='block'}

function initialSetup(){
  const ns=setupNames.value.split(/\n|,/).map(x=>x.trim()).filter(Boolean),ap=setupAdminPw.value.trim();
  if(!ns.length||!ap){setupError.textContent='スタッフ名と管理者パスワードを入力してください。';return;}
  let fields='<h3>各スタッフのパスワード</h3><p class="notice">スタッフ本人に伝えるパスワードを設定してください。</p>';
  ns.forEach((n,i)=>fields+=`<label>${esc(n)} のパスワード</label><input type="password" class="setupStaffPw" data-name="${encodeURIComponent(n)}" placeholder="パスワード">`);
  setupPasswordArea.innerHTML=fields;
  setupPasswordArea.dataset.names=JSON.stringify(ns);
  setupNext.style.display='none';
  const btn=document.createElement('button');btn.className='primary';btn.textContent='初期設定を完了する';btn.id='setupFinish';setupPasswordArea.appendChild(btn);
  bindTap(btn,async()=>{
    const acc={};let ok=true;
    document.querySelectorAll('.setupStaffPw').forEach(e=>{e.blur();if(!e.value)ok=false;acc[decodeURIComponent(e.dataset.name)]=e.value});
    if(!ok){setupError.textContent='全スタッフのパスワードを入力してください。';return}
    btn.disabled=true;btn.textContent='保存中…';
    try{
      await api('setup',{names:ns,adminPassword:ap,passwords:acc});
      alert('初期設定が完了しました。');
      location.reload();
    }catch(e){
      console.error('初期設定の保存に失敗しました',e);
      setupError.textContent=e.server?e.message:'保存に失敗しました。通信環境を確認してもう一度お試しください。';
      btn.disabled=false;btn.textContent='初期設定を完了する';
    }
  });
}
bindTap(setupNext,initialSetup);

staffLoginChoice.onclick=showStaffLogin;
adminLoginChoice.onclick=showAdminLogin;
backChoice1.onclick=openChoice;backChoice2.onclick=openChoice;

bindTap(staffLoginBtn,async()=>{
  const n=staffNameLogin.value,p=staffPwLogin.value;
  staffPwLogin.blur(); // タップ直後にキーボードを閉じる
  staffLoginBtn.disabled=true;staffLoginBtn.textContent='読み込み中…';showWait(staffLoginError,true);
  window.onApiRetry=k=>{staffLoginError.style.color='#666';staffLoginError.textContent='接続に時間がかかっています。自動でやり直しています（'+k+'回目）…';};
  try{
    makePeriods();
    const r=await api('login',{role:'staff',name:n,password:p,keys:preloadKeys()}); // 判定はサーバー側で行う
    authToken=r.token;loggedUser=n;isAdmin=false;
    localStorage.setItem('lastStaffName',n);
    if(r.values)applyPreload(r.values);else await preloadPeriods();
    showWait(staffLoginError,false);
    loginOverlay.style.display='none';staffArea.style.display='block';adminView.style.display='none';
    currentUser.textContent='ログイン中：'+n;renderAll();
  }catch(e){
    console.error('ログインに失敗しました',e);
    authToken='';loggedUser='';
    showWait(staffLoginError,false);
    staffLoginError.textContent=e.server?e.message:'通信に失敗しました。もう一度お試しください。（'+(e&&e.message?e.message:e)+'）';
  }finally{window.onApiRetry=null;staffLoginBtn.disabled=false;staffLoginBtn.textContent='ログイン';}
});
bindTap(adminLoginBtn,async()=>{
  const p=adminPwLogin.value;
  adminPwLogin.blur(); // タップ直後にキーボードを閉じる
  adminLoginBtn.disabled=true;adminLoginBtn.textContent='確認中…';showWait(adminLoginError,true);
  window.onApiRetry=k=>{adminLoginError.style.color='#666';adminLoginError.textContent='接続に時間がかかっています。自動でやり直しています（'+k+'回目）…';};
  try{
    makePeriods();
    const r=await api('login',{role:'admin',password:p,keys:preloadKeys()}); // 判定はサーバー側で行う
    authToken=r.token;isAdmin=true;loggedUser='管理者';
    if(r.values)applyPreload(r.values);else await preloadPeriods();
    showWait(adminLoginError,false);
    loginOverlay.style.display='none';staffArea.style.display='none';adminView.style.display='block';
    currentUser.textContent='管理者';renderAll();
  }catch(e){
    console.error('ログインに失敗しました',e);
    authToken='';isAdmin=false;loggedUser='';
    showWait(adminLoginError,false);
    adminLoginError.textContent=e.server?e.message:'通信に失敗しました。もう一度お試しください。（'+(e&&e.message?e.message:e)+'）';
  }finally{window.onApiRetry=null;adminLoginBtn.disabled=false;adminLoginBtn.textContent='管理者としてログイン';}
});
logoutBtn.onclick=()=>location.reload();

staffManageBtn.onclick=()=>{
  deadlinePanel.style.display='none';
  staffManage.style.display=staffManage.style.display==='none'?'block':'none';
  manageStaff.value=names().map(n=>`${n}｜`).join('\n');
  newAdminPw.value='';
};

function renderDeadlineList(){
  deadlineList.innerHTML=[...period.options].map(o=>{
    const key=o.value,label=o.textContent,val=deadlineFor(key);
    return `<div class="row" style="justify-content:space-between;margin:8px 0"><span class="small">${label}</span><input type="date" data-period="${esc(key)}" value="${esc(val)}"></div>`;
  }).join('');
}
deadlineBtn.onclick=()=>{
  staffManage.style.display='none';
  const willShow=deadlinePanel.style.display==='none';
  deadlinePanel.style.display=willShow?'block':'none';
  if(willShow)renderDeadlineList();
};
deadlineSave.onclick=async()=>{
  const dl={...cachedDeadlines};
  deadlineList.querySelectorAll('input[data-period]').forEach(inp=>{
    if(inp.value)dl[inp.dataset.period]=inp.value;else delete dl[inp.dataset.period];
  });
  deadlineMsg.textContent='保存中…';
  try{
    await saveDeadlines(dl);
    deadlineMsg.textContent='保存しました';setTimeout(()=>deadlineMsg.textContent='',1500);
  }catch(e){
    console.error('締切設定の保存に失敗しました',e);
    deadlineMsg.textContent=e.server?e.message:'保存に失敗しました。もう一度お試しください。';
  }
};
manageSave.onclick=async()=>{
  const lines=manageStaff.value.split('\n').map(x=>x.trim()).filter(Boolean),staff=[];
  for(const line of lines){
    const i=line.indexOf('｜');
    const n=(i<0?line:line.slice(0,i)).trim(),p=(i<0?'':line.slice(i+1)).trim();
    if(!n){manageMsg.textContent='形式は「名前｜パスワード」です。';return}
    staff.push({name:n,password:p});
  }
  if(!staff.length){manageMsg.textContent='スタッフを1人以上登録してください。';return}
  manageMsg.textContent='保存中…';
  try{
    const r=await api('setStaff',{staff,adminPassword:newAdminPw.value.trim()});
    if(r.token)authToken=r.token; // パスワード変更などでログイン券が更新されたときは、新しい券に差し替える
    cachedNames=r.names;writeCfgCache();
    manageStaff.value=names().map(n=>`${n}｜`).join('\n');newAdminPw.value='';
    manageMsg.textContent='保存しました';renderAdmin();setTimeout(()=>manageMsg.textContent='',1500);
  }catch(e){
    console.error('スタッフ設定の保存に失敗しました',e);manageMsg.textContent=e.server?e.message:'保存に失敗しました。もう一度お試しください。';
  }
};

async function boot(){
  loginOverlay.style.display='flex';firstSetup.style.display='none';loginChoice.style.display='none';
  staffLoginBox.style.display='none';adminLoginBox.style.display='none';
  makePeriods();
  // 2回目以降：前回の名前一覧ですぐログイン画面を出し、最新の情報は裏で取得して更新する
  const cached=readCfgCache();
  if(cached){
    cachedNames=cached.names;configured=true;
    openChoice();
    loadConfig().then(()=>{
      writeCfgCache();
      if(!configured){ // サーバー側が初期化し直された場合
        loginChoice.style.display='none';staffLoginBox.style.display='none';adminLoginBox.style.display='none';
        firstSetup.style.display='block';
        return;
      }
      if(staffLoginBox.style.display==='block')fillStaffNames(staffNameLogin.value);
    }).catch(e=>console.error('設定の更新に失敗しました（前回の情報で表示中）',e));
    return;
  }
  // 初めて開くとき：サーバーの返事を待つ
  const loadingMsg=document.createElement('p');loadingMsg.id='bootLoading';loadingMsg.className='notice';loadingMsg.textContent='読み込み中…';
  document.querySelector('.loginBox').prepend(loadingMsg);
  try{
    await loadConfig();
  }catch(e){
    console.error('設定の読み込みに失敗しました',e);
    loadingMsg.className='error';
    loadingMsg.textContent='サーバーに接続できませんでした。通信環境を確認して、ページを再読み込みしてください。\n（原因: '+(e&&e.message?e.message:e)+'）';
    loadingMsg.style.whiteSpace='pre-wrap';
    return;
  }
  loadingMsg.remove();
  writeCfgCache();
  if(!configured){
    firstSetup.style.display='block';loginChoice.style.display='none';
  }else{
    firstSetup.style.display='none';openChoice();
  }
}
boot();
