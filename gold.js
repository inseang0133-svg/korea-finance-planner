(() => {
"use strict";

/*
  Gold Portfolio module
  - Isolated from index.html / script.js
  - LocalStorage only for portfolio records
  - Market reference: Gold API XAU/USD + USD/THB
  - Current market is an estimate, not an official Gold Wallet quote.
*/

const STORAGE_KEY = "kfp_gold_lots_v1";
const HISTORY_KEY = "kfp_gold_market_history_v1";
const SETTINGS_KEY = "kfp_gold_settings_v1";
const DAILY_HISTORY_KEY = "kfp_gold_daily_history_v2";
const INTRADAY_HISTORY_KEY = "kfp_gold_intraday_history_v2";
const DAILY_HISTORY_RETENTION_DAYS = 5 * 365;
const INTRADAY_HISTORY_RETENTION_DAYS = 14;

const OZ_TO_GRAM = 31.1034768;
const PURCHASE_TIMEZONE = "Asia/Seoul";
const BAHT_GOLD_GRAM = 15.244; // standard Thai gold-weight reference
const POLL_MS = 60_000;

let state = {
  spotUsdOz: null,
  usdThb: null,
  priceThbGram: null,
  priceThbOz: null,
  updatedAt: null,
  source: null,
  range: "1D",
  timer: null
};

let tvChart = null;
let tvSeries = null;
let tvCandleSeries = null;
let tvChartOz = null;
let tvSeriesOz = null;
let tvCandleSeriesOz = null;
let chartMode = "line";
let chartInterval = "5m";
let tvChartReadyKey = null;
const CHART_VIEW_KEY = "kfp_gold_chart_view_v2";
const CHART_INTERVALS = {"5m":5*60*1000,"15m":15*60*1000,"30m":30*60*1000,"1H":60*60*1000,"1D":24*60*60*1000};
const CHART_RANGES = {"1D":1,"7D":7,"30D":30,"3M":90,"1Y":365,"5Y":1825};

const $ = id => document.getElementById(id);
const money = n => Number.isFinite(n) ? new Intl.NumberFormat("th-TH",{style:"currency",currency:"THB",maximumFractionDigits:2}).format(n) : "฿0";
const num = (n,d=4) => Number.isFinite(n) ? new Intl.NumberFormat("en-US",{maximumFractionDigits:d}).format(n) : "-";
const pct = n => `${n >= 0 ? "+" : ""}${Number(n || 0).toFixed(2)}%`;
const isoDate = d => new Date(d).toISOString().slice(0,10);

function loadLots(){
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}
function saveLots(lots){ localStorage.setItem(STORAGE_KEY, JSON.stringify(lots)); }

function loadHistory(){
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch { return []; }
}
function saveHistory(history){ localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }

function loadSettings(){
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); }
  catch { return {}; }
}
function saveSettings(s){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

function unitToGrams(quantity, unit){
  if (!Number.isFinite(quantity)) return 0;
  if(unit === "oz") return quantity * OZ_TO_GRAM;
  if(unit === "baht") return quantity * BAHT_GOLD_GRAM;
  return quantity;
}

function parseLotTimestamp(date, time){
  if(!date) return NaN;
  const t = time || "00:00";
  // Purchase form time is always Korea local time (Asia/Seoul).
  const d = new Date(`${date}T${t}:00+09:00`);
  return d.getTime();
}

function formatDateTime(date, time){
  if(!date) return "-";
  const ts = parseLotTimestamp(date, time);
  if(!Number.isFinite(ts)) return date;
  return new Intl.DateTimeFormat("th-TH",{
    timeZone:PURCHASE_TIMEZONE,
    dateStyle:"medium",
    timeStyle:time ? "short" : undefined
  }).format(new Date(ts));
}

function formatChartTime(timestamp){
  return new Intl.DateTimeFormat("th-TH",{
    timeZone:PURCHASE_TIMEZONE,
    month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false
  }).format(new Date(Number(timestamp)*1000));
}

function getEffectiveSellPrice(){
  const settings = loadSettings();
  const marketPrice = Number(state.priceThbGram);
  // Use the live market quote by default. A manually entered Gold Wallet
  // sell quote is used ONLY when the user explicitly enables the checkbox.
  if(settings.useSellOverride === true && Number(settings.sellOverride) > 0){
    return {price:Number(settings.sellOverride), exact:true, source:"wallet"};
  }
  return {price:Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : 0, exact:false, source:"market"};
}

function calculateLot(lot){
  const quote = getEffectiveSellPrice();
  const purity = Number(lot.goldType || 99.99) / 99.99;
  const sell = quote.exact ? quote.price : quote.price * purity;
  const grams = Number(lot.grams) || 0;
  const cost = Number(lot.costThb) || 0;
  const value = grams * sell;
  const pl = value - cost;
  const plPct = cost ? (pl / cost) * 100 : 0;
  const avgCost = grams ? cost / grams : 0;
  return {...lot, grams, cost, value, pl, plPct, avgCost};
}

function calculatePortfolio(){
  const lots = loadLots().map(calculateLot);
  const totalGrams = lots.reduce((s,l)=>s+l.grams,0);
  const totalCost = lots.reduce((s,l)=>s+l.cost,0);
  const currentValue = lots.reduce((s,l)=>s+l.value,0);
  const netPL = currentValue - totalCost;
  const positivePL = lots.filter(l=>l.pl>0).reduce((s,l)=>s+l.pl,0);
  const negativePL = lots.filter(l=>l.pl<0).reduce((s,l)=>s+l.pl,0);
  const wins = lots.filter(l=>l.pl>0).length;
  const losses = lots.filter(l=>l.pl<0).length;
  return {
    lots,totalGrams,totalCost,currentValue,netPL,
    netPLPct:totalCost ? netPL/totalCost*100 : 0,
    positivePL,negativePL,wins,losses,
    avgCost:totalGrams ? totalCost/totalGrams : 0
  };
}

async function fetchJSON(url){
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), 9000);
  try{
    const r = await fetch(url,{cache:"no-store",signal:controller.signal});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timeout); }
}

async function fetchGold(){
  /*
    Browser-safe primary source: XAUS.
    - CORS open
    - no API key
    - direct THB/gram conversion
    - also exposes FX and freshness state

    Fallback: Gold API (also CORS-enabled), then the last cached market value.
  */
  const errors=[];
  try{
    const url=`https://xaus.com/api/v1/spot?currency=THB&unit=gram&compact=1&fresh=${Date.now()}`;
    const data=await fetchJSON(url);
    const price=Number(data?.xau?.price);
    const spot=Number(data?.spot_usd_oz);
    const fx=Number(data?.fx_rate);
    if(!Number.isFinite(price)||price<=0) throw new Error("XAUS: invalid THB/gram price");

    state.priceThbGram=price*(99.99/100);
    state.priceThbOz=state.priceThbGram*OZ_TO_GRAM;
    state.spotUsdOz=Number.isFinite(spot)?spot:null;
    state.usdThb=Number.isFinite(fx)?fx:null;
    state.updatedAt=data.price_as_of||data.updated_at||new Date().toISOString();
    state.source=data.stale?"XAUS · stale cache":"XAUS · live";
    persistLastMarket();
    appendHistory();
    await fetchIntradayGold();
    renderMarket();renderPortfolio();renderLots();renderChart();
    return true;
  }catch(e){ errors.push(`XAUS: ${e.message}`); }

  try{
    const data=await fetchJSON(`https://api.gold-api.com/price/XAU?fresh=${Date.now()}`);
    const spot=Number(data?.price);
    if(!Number.isFinite(spot)||spot<=0) throw new Error("invalid Gold API price");
    const fxData=await fetchJSON("https://api.frankfurter.app/latest?from=USD&to=THB");
    const fx=Number(fxData?.rates?.THB);
    if(!Number.isFinite(fx)||fx<=0) throw new Error("invalid USD/THB");
    applyMarket(spot,fx,"Gold API + Frankfurter");
    await fetchIntradayGold();
    return true;
  }catch(e){ errors.push(`Gold API: ${e.message}`); }

  setMarketOffline(errors.join(" | ")||"API unavailable");
  return false;
}

async function fetchIntradayGold(){
  try{
    const data=await fetchJSON(`https://xaus.com/api/v1/intraday?symbol=xau&hours=24&fresh=${Date.now()}`);
    const raw=Array.isArray(data?.points)?data.points:[];
    if(!raw.length) return false;
    const rows=raw.map(p=>{
      const ts=typeof p.t==="number" ? (p.t<1e12?p.t*1000:p.t) : Date.parse(p.t);
      const price=Number(p.p);
      if(!Number.isFinite(ts)||!Number.isFinite(price)||price<=0)return null;
      // Intraday endpoint is XAU/USD. Convert with the current FX as a
      // reference; live THB price above remains the authoritative portfolio quote.
      const fx=Number(state.usdThb);
      const thb=Number.isFinite(fx)&&fx>0 ? price*fx/OZ_TO_GRAM*(99.99/100) : null;
      return thb?{ts,price:thb,usd:price,source:"xaus-intraday"}:null;
    }).filter(Boolean).sort((a,b)=>a.ts-b.ts);
    if(rows.length){
      const old=(()=>{try{return JSON.parse(localStorage.getItem(INTRADAY_HISTORY_KEY)||"[]")}catch{return []}})();
      const merged=dedupPoints(old.concat(rows));
      const cutoff=Date.now()-INTRADAY_HISTORY_RETENTION_DAYS*86400000;
      localStorage.setItem(INTRADAY_HISTORY_KEY,JSON.stringify(merged.filter(x=>x.ts>=cutoff).slice(-12000)));
      renderChart();
    }
    return true;
  }catch(_){ return false; }
}
function persistLastMarket(){
  localStorage.setItem("kfp_gold_last_market",JSON.stringify({
    spotUsdOz:state.spotUsdOz,usdThb:state.usdThb,
    priceThbOz:state.priceThbOz,priceThbGram:state.priceThbGram,
    updatedAt:state.updatedAt,source:state.source
  }));
}

function applyMarket(spotUsdOz,fx,source){
  state.spotUsdOz=spotUsdOz;
  state.usdThb=fx;
  state.priceThbOz=spotUsdOz*fx;
  state.priceThbGram=state.priceThbOz/OZ_TO_GRAM;
  state.updatedAt=new Date().toISOString();
  state.source=source;
  localStorage.setItem("kfp_gold_last_market",JSON.stringify({
    spotUsdOz:state.spotUsdOz,usdThb:state.usdThb,
    priceThbOz:state.priceThbOz,priceThbGram:state.priceThbGram,
    updatedAt:state.updatedAt,source
  }));
  appendHistory();
  renderMarket();
  renderPortfolio();
  renderLots();
  renderChart();
}

function loadLastMarket(){
  try{
    const x=JSON.parse(localStorage.getItem("kfp_gold_last_market")||"null");
    if(x && Number.isFinite(Number(x.priceThbGram))){
      state={...state,...x,priceThbGram:Number(x.priceThbGram),priceThbOz:Number(x.priceThbOz)};
      renderMarket();
      return x;
    }
  }catch{}
  return null;
}

function setMarketOffline(message){
  $("marketDot").className="status-dot offline";
  $("marketStatus").textContent="API ราคาทองไม่ตอบสนอง — ใช้ค่าที่บันทึกไว้";
  $("marketUpdated").textContent=state.updatedAt
    ? `ล่าสุด ${new Date(state.updatedAt).toLocaleString("th-TH")}` : "ยังไม่มีข้อมูล";
  const hint=$("chartHint");
  if(hint){
    hint.textContent=state.priceThbGram
      ? "ออฟไลน์ชั่วคราว · ใช้ราคาล่าสุดที่บันทึกไว้"
      : "ยังเชื่อมต่อ API ไม่ได้ · กด 🔄 อัปเดตอีกครั้ง";
    hint.title=message || "API unavailable";
  }
  renderMarket(); renderPortfolio(); renderLots(); renderChart();
}
function renderMarket(){
  $("marketDot").className="status-dot online";
  $("marketStatus").textContent=state.source ? `LIVE · ${state.source}` : "LIVE";
  $("marketUpdated").textContent=state.updatedAt ? `อัปเดต ${new Date(state.updatedAt).toLocaleTimeString("th-TH")}` : "-";
  $("spotUsd").textContent=state.spotUsdOz ? `$${num(state.spotUsdOz,2)}` : "-";
  $("usdThb").textContent=state.usdThb ? num(state.usdThb,4) : "-";
  $("goldThbGram").textContent=state.priceThbGram ? money(state.priceThbGram) : "-";
  $("goldThbOz").textContent=state.priceThbOz ? money(state.priceThbOz) : "-";
}

function appendHistory(){
  if(!Number.isFinite(Number(state.priceThbGram)) || Number(state.priceThbGram)<=0) return;
  const history=loadHistory(); const now=Date.now(); const last=history[history.length-1];
  if(last && now-last.ts<50_000) return;
  history.push({ts:now,price:Number(state.priceThbGram),usd:Number(state.spotUsdOz)||null});
  const cutoff=now-31*86400000;
  saveHistory(history.filter(x=>x.ts>=cutoff).slice(-5000));
}
function loadDailyHistory(){try{return JSON.parse(localStorage.getItem(DAILY_HISTORY_KEY)||"[]")}catch{return []}}
function saveDailyHistory(rows){localStorage.setItem(DAILY_HISTORY_KEY,JSON.stringify(rows.slice(-2200)))}
function ymd(d){return new Date(d).toISOString().slice(0,10)}

async function fetchHistoricalGold(){
  const now=new Date(), days=Math.min(CHART_RANGES[state.range]||30,DAILY_HISTORY_RETENTION_DAYS);
  const from=new Date(now.getTime()-days*86400000);
  const fromDate=ymd(from),toDate=ymd(now);
  try{
    const data=await fetchJSON(`https://xaus.com/api/v1/history?fresh=${Date.now()}`);
    const points=Array.isArray(data?.points)?data.points:[];
    if(!points.length) throw new Error("ไม่มี daily history");
    const fx=Number(state.usdThb);
    const rows=points.map(p=>{
      const date=String(p.d||"").slice(0,10), usd=Number(p.c);
      if(!date||!Number.isFinite(usd))return null;
      const thb=Number.isFinite(fx)&&fx>0 ? usd*fx/OZ_TO_GRAM*(99.99/100) : null;
      return thb?{ts:new Date(`${date}T12:00:00Z`).getTime(),price:thb,usd, date,source:"xaus-daily"}:null;
    }).filter(Boolean).filter(x=>x.ts>=from.getTime()).sort((a,b)=>a.ts-b.ts);
    if(rows.length){
      saveDailyHistory(rows);
      renderChart();
      const hint=$("chartHint");
      if(hint&&state.range!=="1D") hint.textContent=`ข้อมูลย้อนหลัง ${rows.length} วัน · ${state.range} · XAU/USD × FX ปัจจุบัน (ประมาณ)`;
    }
    return true;
  }catch(_){
    // Secondary historical source. Kept as a fallback if XAUS history is unavailable.
    try{
      const data=await fetchJSON(`https://api.goldprice.dev/v1/bars?symbol=XAU-USD-SPOT&interval=1d&from=${fromDate}&to=${toDate}&limit=100`);
      const bars=Array.isArray(data?.bars)?data.bars:[];
      const fx=Number(state.usdThb);
      const rows=bars.map(b=>{
        const date=String(b.bar_start||"").slice(0,10),usd=Number(b.close);
        const thb=Number.isFinite(fx)&&fx>0?usd*fx/OZ_TO_GRAM*(99.99/100):null;
        return date&&Number.isFinite(usd)&&thb?{ts:new Date(`${date}T12:00:00Z`).getTime(),price:thb,usd,date,source:"goldprice-daily"}:null;
      }).filter(Boolean).sort((a,b)=>a.ts-b.ts);
      if(rows.length){saveDailyHistory(rows);renderChart();return true;}
    }catch(_){ }
    const hint=$("chartHint");
    if(hint&&state.range!=="1D")hint.textContent=`โหลดข้อมูลย้อนหลัง ${state.range} ไม่ได้ · แสดงข้อมูลที่เคยบันทึกไว้แทน`;
    return false;
  }
}

function renderPortfolio(){
  const p=calculatePortfolio();
  $("totalGold").textContent=`${num(p.totalGrams,4)} g`;
  $("totalGoldOz").textContent=`${num(p.totalGrams/OZ_TO_GRAM,6)} oz`;
  $("totalCost").textContent=money(p.totalCost);
  $("currentValue").textContent=money(p.currentValue);
  $("lotCount").textContent=`${p.lots.length} รอบ`;
  $("netPL").textContent=`${p.netPL>=0?"+":""}${money(p.netPL)}`;
  $("netPLPct").textContent=pct(p.netPLPct);
  $("positivePL").textContent=`+${money(p.positivePL)}`;
  $("negativePL").textContent=money(p.negativePL);
  $("avgCost").textContent=money(p.avgCost)+"/g";
  const sellQuote=getEffectiveSellPrice();
  const valueHint=$("portfolioValueHint");
  if(valueHint){
    valueHint.textContent=sellQuote.exact
      ? `ประเมินด้วยราคาขายคืนจริง ${money(sellQuote.price)}/g`
      : `ประเมินด้วยราคาตลาด ${money(sellQuote.price)}/g`;
  }
  $("winRate").textContent=`${p.wins} / ${p.lots.length}`;
  $("winRatePct").textContent=p.lots.length ? `${(p.wins/p.lots.length*100).toFixed(2)}%` : "0.00%";

  const card=$("netPLCard");
  card.classList.toggle("positive",p.netPL>0);
  card.classList.toggle("negative",p.netPL<0);
}

function renderLots(){
  const p=calculatePortfolio();
  $("lotSummary").textContent=p.lots.length
    ? `ทั้งหมด ${p.lots.length} รอบ · 🟢 ${p.wins} รอบกำไร · 🔴 ${p.losses} รอบขาดทุน · เรียงจากล่าสุด`
    : "";
  const box=$("lotsList");
  if(!p.lots.length){
    box.innerHTML=`<div class="empty-state">ยังไม่มีรายการซื้อ<br>เริ่มจากบันทึกรอบแรกด้านบนได้เลย</div>`;
    return;
  }
  box.innerHTML=p.lots.slice().reverse().map((l,i)=>{
    const cls=l.pl>0?"positive":l.pl<0?"negative":"";
    const text=l.pl>0?"positive-text":l.pl<0?"negative-text":"neutral-text";
    const status=l.pl>0?"🟢 กำไร":l.pl<0?"🔴 ขาดทุน":"⚪ จุดคุ้มทุน";
    return `
      <article class="lot-item ${cls}">
        <div class="lot-main">
          <div>
            <div class="lot-title">#${String(p.lots.length-i).padStart(3,"0")} · ${l.goldType||"99.99"}% · ${status}</div>
            <div class="lot-meta">${formatDateTime(l.date,l.time)} · ${num(l.grams,6)} g</div>
          </div>
          <div class="lot-pl ${text}">
            ${l.pl>=0?"+":""}${money(l.pl)}<br>
            <small>${pct(l.plPct)}</small>
          </div>
        </div>
        <div class="lot-grid">
          <div class="lot-cell"><span>ต้นทุน</span><b>${money(l.cost)}</b></div>
          <div class="lot-cell"><span>มูลค่าปัจจุบัน</span><b>${money(l.value)}</b></div>
          <div class="lot-cell"><span>ต้นทุนเฉลี่ย</span><b>${money(l.avgCost)}/g</b></div>
          <div class="lot-cell"><span>ราคาประเมินขาย</span><b>${money(l.goldType === "96.5" && !getEffectiveSellPrice().exact ? getEffectiveSellPrice().price * 0.965 : getEffectiveSellPrice().price)}/g</b></div>
        </div>
        ${l.note ? `<div class="lot-note">📝 ${escapeHTML(l.note)}</div>` : ""}
        <div class="lot-actions"><button class="delete-lot" data-id="${l.id}">ลบรอบนี้</button></div>
      </article>`;
  }).join("");
}

function escapeHTML(s){
  return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}

function loadChartViews(){
  try{return JSON.parse(localStorage.getItem(CHART_VIEW_KEY)||"{}")}catch{return {}}
}
function saveChartView(){
  if(!tvChart)return;
  try{
    const visible=tvChart.timeScale().getVisibleRange();
    if(!visible)return;
    const views=loadChartViews();
    views[`${state.range}_${chartInterval}`]={from:visible.from,to:visible.to};
    localStorage.setItem(CHART_VIEW_KEY,JSON.stringify(views));
  }catch(_){ }
}
function chartRangeKey(){return `${state.range}_${chartInterval}`}
function getLotsForChart(){
  const now=Date.now();
  const days=CHART_RANGES[state.range]||30;
  const start=now-days*86400000;
  const end=now+86400000;
  return loadLots().filter(l=>{
    const ts=parseLotTimestamp(l.date,l.time);
    if(!Number.isFinite(ts)) return false;
    // Keep the chart's 1D data window unchanged, but allow a purchase
    // marker from the immediately preceding day to remain discoverable.
    // This is important for a purchase such as yesterday 02:34 when the
    // current time is today 07:xx: the marker should not silently vanish.
    const markerStart = state.range==="1D" ? start-86400000 : start;
    return ts>=markerStart && ts<=end;
  });
}
function extendRangeForLots(data){
  if(!data.length)return null;
  const times=data.map(x=>x.time);
  let from=Math.min(...times),to=Math.max(...times);
  const lots=getLotsForChart();
  for(const l of lots){
    const ts=Math.floor(parseLotTimestamp(l.date,l.time)/1000);
    if(Number.isFinite(ts)){from=Math.min(from,ts);to=Math.max(to,ts);}
  }
  const span=Math.max(3600,to-from);
  return {from:from-span*0.03,to:to+span*0.03};
}

function rawIntradayPoints(){
  const now=Date.now();
  const remote=(()=>{try{return JSON.parse(localStorage.getItem(INTRADAY_HISTORY_KEY)||"[]")}catch{return []}})();
  const cutoff=now-INTRADAY_HISTORY_RETENTION_DAYS*86400000;
  return remote.filter(x=>x.ts>=cutoff&&Number.isFinite(Number(x.price)))
    .concat(loadHistory().filter(x=>x.ts>=cutoff&&Number.isFinite(Number(x.price))))
    .map(x=>({ts:Number(x.ts),price:Number(x.price),usd:Number(x.usd)}))
    .filter(x=>Number.isFinite(x.ts)&&Number.isFinite(x.price)&&x.price>0)
    .sort((a,b)=>a.ts-b.ts);
}
function rawDailyPoints(){
  const now=Date.now(),days=CHART_RANGES[state.range]||30,start=now-days*86400000;
  return loadDailyHistory().filter(x=>x.ts>=start&&Number.isFinite(Number(x.price)))
    .map(x=>({ts:Number(x.ts),price:Number(x.price),usd:Number(x.usd)}))
    .sort((a,b)=>a.ts-b.ts);
}
function chartFx(){
  if(Number.isFinite(Number(state.usdThb))&&Number(state.usdThb)>0)return Number(state.usdThb);
  if(Number.isFinite(Number(state.priceThbOz))&&Number(state.priceThbOz)>0&&Number.isFinite(Number(state.spotUsdOz))&&Number(state.spotUsdOz)>0) return Number(state.priceThbOz)/Number(state.spotUsdOz);
  return null;
}
function pointUsdOz(p){
  if(Number.isFinite(p.usd)&&p.usd>0)return p.usd;
  const fx=chartFx();
  return fx&&p.price>0 ? (p.price*OZ_TO_GRAM/fx)/(99.99/100) : NaN;
}
function dedupPoints(points){
  const out=[];
  for(const p of points){
    const prev=out[out.length-1];
    if(prev && Math.abs(prev.ts-p.ts)<1000){prev.price=p.price;continue;}
    out.push(p);
  }
  return out;
}
function aggregateIntraday(points,interval){
  const bucket=CHART_INTERVALS[interval]||CHART_INTERVALS["5m"];
  const map=new Map();
  for(const p of points){
    const b=Math.floor(p.ts/bucket)*bucket;
    let x=map.get(b);
    if(!x)x={time:Math.floor(b/1000),open:p.price,high:p.price,low:p.price,close:p.price};
    else{x.high=Math.max(x.high,p.price);x.low=Math.min(x.low,p.price);x.close=p.price;}
    map.set(b,x);
  }
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
function aggregateDaily(points){
  const out=[];
  for(const p of points){
    const close=p.price,prev=out[out.length-1]?.close;
    const open=Number.isFinite(prev)?prev:close;
    out.push({time:Math.floor(p.ts/1000),open,high:Math.max(open,close),low:Math.min(open,close),close});
  }
  return out;
}
function getChartOHLC(){
  let points=state.range==="1D" ? rawIntradayPoints().filter(x=>x.ts>=Date.now()-86400000) : rawDailyPoints();
  if(!points.length)return [];
  return state.range==="1D" ? aggregateIntraday(dedupPoints(points),chartInterval) : aggregateDaily(points);
}
function getChartUSD_OHLC(){
  let points=state.range==="1D" ? rawIntradayPoints().filter(x=>x.ts>=Date.now()-86400000) : rawDailyPoints();
  if(!points.length)return [];
  const usdPoints=points.map(p=>({ts:p.ts,price:pointUsdOz(p)})).filter(p=>Number.isFinite(p.price)&&p.price>0);
  if(!usdPoints.length)return [];
  return state.range==="1D" ? aggregateIntraday(dedupPoints(usdPoints),chartInterval) : aggregateDaily(usdPoints);
}
function lineDataFromOHLC(data){return data.map(x=>({time:x.time,value:x.close}));}
function scaleOHLC(data,factor){return data.map(x=>({time:x.time,open:x.open*factor,high:x.high*factor,low:x.low*factor,close:x.close*factor}));}
function chartTime(ts){return Math.floor(Number(ts)/1000)}
function formatChartPrice(v,dec=2){return `฿${Number(v).toLocaleString("th-TH",{minimumFractionDigits:dec,maximumFractionDigits:dec})}`}
function formatUsdPrice(v,dec=2){return `$${Number(v).toLocaleString("en-US",{minimumFractionDigits:dec,maximumFractionDigits:dec})}`}

function ensureTradingViewChart(){
  if(tvChart&&tvChartOz)return true;
  if(!window.LightweightCharts){
    const hint=$("chartHint");if(hint)hint.textContent="กำลังโหลดระบบกราฟ…";return false;
  }
  const makeChart=(id)=>{
    const el=$(id);if(!el)return null;
    return LightweightCharts.createChart(el,{autoSize:true,layout:{background:{type:"solid",color:"#0f1112"},textColor:"#777"},localization:{timeFormatter:formatChartTime},grid:{vertLines:{color:"#171919"},horzLines:{color:"#292b2b"}},rightPriceScale:{borderColor:"#292b2b",scaleMargins:{top:.08,bottom:.08}},timeScale:{borderColor:"#292b2b",timeVisible:true,secondsVisible:false,rightOffset:5,barSpacing:7,minBarSpacing:2},crosshair:{mode:LightweightCharts.CrosshairMode.Normal,vertLine:{color:"#d4af37",width:1,style:2,labelBackgroundColor:"#8f7218"},horzLine:{color:"#d4af37",width:1,style:2,labelBackgroundColor:"#8f7218"}},handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:true,axisDoubleClickReset:true}});
  };
  tvChart=makeChart("goldChart"); tvChartOz=makeChart("goldChartOz");
  if(!tvChart||!tvChartOz)return false;
  const areaOpts={topColor:"rgba(212,175,55,.24)",bottomColor:"rgba(212,175,55,.015)",lineColor:"#d4af37",lineWidth:2,priceLineVisible:true,lastValueVisible:true,crosshairMarkerVisible:true,crosshairMarkerRadius:4,priceFormat:{type:"price",precision:2,minMove:.01}};
  const candleOpts={upColor:"#62db8a",downColor:"#ff5d68",borderUpColor:"#62db8a",borderDownColor:"#ff5d68",wickUpColor:"#62db8a",wickDownColor:"#ff5d68",priceFormat:{type:"price",precision:2,minMove:.01}};
  tvSeries=tvChart.addAreaSeries(areaOpts);tvCandleSeries=tvChart.addCandlestickSeries(candleOpts);
  tvSeriesOz=tvChartOz.addAreaSeries(areaOpts);tvCandleSeriesOz=tvChartOz.addCandlestickSeries(candleOpts);

  // Keep purchase markers/lines inside the visible price scale.
  // A lot bought well below the current market price (e.g. 4,372 vs 4,611)
  // must still be visible on the chart instead of disappearing outside the plot.
  const purchasePrices=(gramMode)=>{
    const prices=[];
    for(const lot of getLotsForChart()){
      const grams=Number(lot.grams)||unitToGrams(Number(lot.quantity)||0,lot.unit);
      if(!(grams>0)) continue;
      const buyGram=Number(lot.buyPriceThbGram)>0?Number(lot.buyPriceThbGram):(Number(lot.costThb)>0?Number(lot.costThb)/grams:0);
      if(!(buyGram>0)) continue;
      if(gramMode) prices.push(buyGram);
      else {
        const fx=chartFx();
        const buyOz=fx&&fx>0?buyGram*OZ_TO_GRAM/fx:0;
        if(buyOz>0) prices.push(buyOz);
      }
    }
    return prices;
  };
  const autoscale=(gramMode)=>(original)=>{
    const info=original();
    if(!info?.priceRange) return info;
    const prices=purchasePrices(gramMode);
    if(!prices.length) return info;
    const min=Math.min(info.priceRange.minValue,...prices);
    const max=Math.max(info.priceRange.maxValue,...prices);
    if(!(Number.isFinite(min)&&Number.isFinite(max))) return info;
    const span=Math.max(max-min,0.000001);
    const pad=span*0.03;
    return {...info,priceRange:{minValue:min-pad,maxValue:max+pad}};
  };
  tvSeries.applyOptions({autoscaleInfoProvider:autoscale(true)});
  tvCandleSeries.applyOptions({autoscaleInfoProvider:autoscale(true)});
  tvSeriesOz.applyOptions({autoscaleInfoProvider:autoscale(false)});
  tvCandleSeriesOz.applyOptions({autoscaleInfoProvider:autoscale(false)});

  setChartMode(chartMode);
  tvChart.timeScale().subscribeVisibleTimeRangeChange(()=>{saveChartView();drawPurchaseOverlays();});
  tvChartOz.timeScale().subscribeVisibleTimeRangeChange(()=>drawPurchaseOverlays());
  const cross=(chart,series,tip,isUsd)=>chart.subscribeCrosshairMove(param=>{
    if(!param.time||!param.seriesData)return;
    const target=chart===tvChartOz ? (chartMode==="candle"?tvCandleSeriesOz:tvSeriesOz) : (chartMode==="candle"?tvCandleSeries:tvSeries);
    const row=param.seriesData.get(target);
    const value=row?.value ?? row?.close;
    if(!Number.isFinite(Number(value)))return;
    const d=new Date(Number(param.time)*1000);
    const label=isUsd?formatUsdPrice(Number(value))+"/troy oz":money(Number(value))+"/g";
    const dt=new Intl.DateTimeFormat("th-TH",{timeZone:PURCHASE_TIMEZONE,day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:false}).format(d);
    $(tip).textContent=`${dt} · ${label}`;
  });
  cross(tvChart,tvSeries,"chartTooltip",false);
  cross(tvChartOz,tvSeriesOz,"chartTooltipOz",true);
  return true;
}
function setChartMode(mode){
  chartMode=mode==="candle"?"candle":"line";
  if(!tvSeries||!tvCandleSeries)return;
  const lineVisible=chartMode==="line";
  tvSeries.applyOptions({visible:lineVisible});tvCandleSeries.applyOptions({visible:!lineVisible});
  tvSeriesOz.applyOptions({visible:lineVisible});tvCandleSeriesOz.applyOptions({visible:!lineVisible});
  const btn=$("chartCandleBtn");if(btn){btn.classList.toggle("active",!lineVisible);btn.textContent=lineVisible?"🕯️ แท่งเทียน":"〽️ กราฟเส้น";}
}
function updateChartStats(pts){
  const values=pts.map(x=>Number(x.close)).filter(Number.isFinite);
  if(!values.length){["chartCurrent","chartHigh","chartLow","chartChange","chartCurrentOz","chartHighOz","chartLowOz","chartChangeOz"].forEach(id=>$(id).textContent="ปัจจุบัน: -");return;}
  const current=values.at(-1),first=values[0],high=Math.max(...values),low=Math.min(...values),change=first?((current-first)/first)*100:0;
  $("chartCurrent").textContent=`ปัจจุบัน: ${money(current)}/g`;
  $("chartHigh").textContent=`สูงสุด: ${money(high)}/g`;
  $("chartLow").textContent=`ต่ำสุด: ${money(low)}/g`;
  $("chartChange").textContent=`เปลี่ยนแปลง: ${change>=0?"+":""}${change.toFixed(2)}%`;
  const usd=getChartUSD_OHLC(),uv=usd.map(x=>Number(x.close)).filter(Number.isFinite);
  if(uv.length){
    const uc=uv.at(-1),uf=uv[0],uh=Math.max(...uv),ul=Math.min(...uv),uchange=uf?((uc-uf)/uf)*100:0;
    $("chartCurrentOz").textContent=`ปัจจุบัน: ${formatUsdPrice(uc)}/troy oz`;
    $("chartHighOz").textContent=`สูงสุด: ${formatUsdPrice(uh)}/troy oz`;
    $("chartLowOz").textContent=`ต่ำสุด: ${formatUsdPrice(ul)}/troy oz`;
    $("chartChangeOz").textContent=`เปลี่ยนแปลง: ${uchange>=0?"+":""}${uchange.toFixed(2)}%`;
  }else{
    ["chartCurrentOz","chartHighOz","chartLowOz"].forEach(id=>$(id).textContent="ปัจจุบัน: -");
    $("chartChangeOz").textContent="เปลี่ยนแปลง: -";
  }
}
function svgEl(tag,attrs){const e=document.createElementNS("http://www.w3.org/2000/svg",tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e;}
function drawPurchaseOverlay(chart,series,svgId,gramMode){
  const svg=$(svgId);if(!svg||!chart||!series)return;
  const host=svg.parentElement;const w=host?.clientWidth||svg.clientWidth,h=host?.clientHeight||svg.clientHeight;svg.setAttribute("viewBox",`0 0 ${w} ${h}`);svg.innerHTML="";
  const lots=getLotsForChart();
  const visible=chart.timeScale().getVisibleRange();if(!visible)return;
  for(const lot of lots){
    const ts=chartTime(parseLotTimestamp(lot.date,lot.time));
    if(!Number.isFinite(ts)||ts<visible.from||ts>visible.to)continue;
    const x=chart.timeScale().timeToCoordinate(ts);if(x==null)continue;
    const grams=Number(lot.grams)||unitToGrams(Number(lot.quantity)||0,lot.unit);
    if(!(grams>0))continue;
    const buyGram=Number(lot.buyPriceThbGram)>0?Number(lot.buyPriceThbGram):(Number(lot.costThb)>0?Number(lot.costThb)/grams:0);
    if(!(buyGram>0))continue;
    const fx=chartFx();
    const buy=gramMode?buyGram:(fx&&fx>0?buyGram*OZ_TO_GRAM/fx:0);
    if(!buy)continue;
    const current=Number(state.priceThbGram)||0;
    if(!(current>0))continue;
    const purity=Number(lot.goldType||99.99)/99.99;
    const currentForLot=current*purity;
    const pl=(currentForLot-buyGram)*grams;
    const y=series.priceToCoordinate(buy);if(y==null){
      // The chart can briefly report null while autoscaling after a data update.
      // Retry on the next frame instead of silently losing the purchase marker.
      requestAnimationFrame(()=>drawPurchaseOverlays());
      continue;
    }
    const positive=pl>=0,color=positive?"#62db8a":"#ff5d68";
    const v=svgEl("line",{x1:x,y1:0,x2:x,y2:h,stroke:color,class:"purchase-vline"});
    const hl=svgEl("line",{x1:0,y1:y,x2:w,y2:y,stroke:color,class:"purchase-hline"});
    const dot=svgEl("circle",{cx:x,cy:y,r:6,fill:color,class:"purchase-dot"});
    const labelX=Math.min(Math.max(x+8,8),Math.max(8,w-145));
    const label=svgEl("text",{x:labelX,y:Math.max(16,y-9),fill:color,class:"purchase-label"});label.textContent=`${positive?"+":""}${money(pl)}`;
    const price=svgEl("text",{x:labelX,y:Math.min(h-8,Math.max(30,y+15)),fill:"#d4af37",class:"purchase-sub"});price.textContent=gramMode?`ซื้อ ${formatChartPrice(buy)}`:`ซื้อ ${formatUsdPrice(buy)}/oz`;
    const time=svgEl("text",{x:Math.min(Math.max(x+5,5),Math.max(5,w-125)),y:h-8,fill:"#bdbdbd",class:"purchase-sub"});time.textContent=`${lot.date} ${lot.time||""} · ${num(grams,4)}g`;
    svg.append(v,hl,dot,label,price,time);
  }
}
function drawPurchaseOverlays(){
  if(!tvChart)return;
  drawPurchaseOverlay(tvChart,chartMode==="candle"?tvCandleSeries:tvSeries,"chartOverlayGram",true);
  drawPurchaseOverlay(tvChartOz,chartMode==="candle"?tvCandleSeriesOz:tvSeriesOz,"chartOverlayOz",false);
}
function restoreChartView(){
  if(!tvChart)return;
  const views=loadChartViews(),saved=views[chartRangeKey()];
  const data=getChartOHLC();
  try{
    if(saved)tvChart.timeScale().setVisibleRange({from:saved.from,to:saved.to});
    else{
      tvChart.timeScale().fitContent();
      const ext=extendRangeForLots(lineDataFromOHLC(data));
      if(ext)tvChart.timeScale().setVisibleRange(ext);
    }
  }catch(_){tvChart.timeScale().fitContent()}
  try{const r=tvChart.timeScale().getVisibleRange();if(r)tvChartOz.timeScale().setVisibleRange(r)}catch(_){ }
  drawPurchaseOverlays();
}
function renderChart(){
  const pts=getChartOHLC();updateChartStats(pts);
  if(!ensureTradingViewChart())return;
  const gramLine=lineDataFromOHLC(pts),gramCandle=pts,ozCandle=getChartUSD_OHLC(),ozLine=lineDataFromOHLC(ozCandle);
  tvSeries.setData(gramLine);tvCandleSeries.setData(gramCandle);tvSeriesOz.setData(ozLine);tvCandleSeriesOz.setData(ozCandle);
  const key=chartRangeKey();
  if(tvChartReadyKey!==key){restoreChartView();tvChartReadyKey=key;}
  const hint=$("chartHint");
  if(hint){
    const source=state.range==="1D"?`Intraday · ${chartInterval} · ${pts.length} แท่ง`:`ย้อนหลัง ${state.range} · ${pts.length} วัน`;
    const candleNote=chartMode==="candle"?(state.range==="1D"?" · OHLC จากจุด Intraday":" · แท่งรายวันเป็นค่าประมาณจากราคาปิด"):" · กราฟเส้น";
    hint.textContent=`ลาก/บีบนิ้วเพื่อเลื่อนและซูม · ${source}${candleNote} · กราฟที่ 2 = USD/troy oz`;
  }
  drawPurchaseOverlays();
}
function resetChartZoom(){
  if(!tvChart)return;
  const views=loadChartViews();delete views[chartRangeKey()];localStorage.setItem(CHART_VIEW_KEY,JSON.stringify(views));tvChart.timeScale().fitContent();
  try{tvChartOz.timeScale().fitContent()}catch(_){ }
  drawPurchaseOverlays();
}
function fitChart(){
  if(!tvChart)return;tvChart.timeScale().fitContent();
  const data=getChartOHLC(),ext=extendRangeForLots(lineDataFromOHLC(data));
  if(ext)try{tvChart.timeScale().setVisibleRange(ext)}catch(_){ }
  try{const r=tvChart.timeScale().getVisibleRange();if(r)tvChartOz.timeScale().setVisibleRange(r)}catch(_){ }
  drawPurchaseOverlays();
}
function toggleChartFullscreen(){
  const wrap=$("goldChart")?.closest(".chart-wrap");if(!wrap)return;wrap.classList.toggle("chart-fullscreen");
  const btn=$("chartFullscreenBtn");if(btn)btn.textContent=wrap.classList.contains("chart-fullscreen")?"✕ ออกจากเต็มจอ":"⛶ เต็มจอ";
  setTimeout(()=>{if(tvChart)tvChart.resize($("goldChart").clientWidth,$("goldChart").clientHeight);if(tvChartOz)tvChartOz.resize($("goldChartOz").clientWidth,$("goldChartOz").clientHeight);drawPurchaseOverlays()},80);
}
function setChartInterval(interval){
  if(!CHART_INTERVALS[interval])return;
  chartInterval=interval;
  document.querySelectorAll(".chart-interval").forEach(x=>x.classList.toggle("active",x.dataset.interval===interval));
  if(interval!=="1D" && state.range!=="1D"){
    document.querySelectorAll(".chart-tab").forEach(x=>x.classList.toggle("active",x.dataset.range==="1D"));
    state.range="1D";
  }
  tvChartReadyKey=null;renderChart();
}
function updateLotPreview(){
  const q=Number($("quantity").value);
  const unit=$("unit").value;
  const cost=Number($("cost").value);
  const grams=unitToGrams(q,unit);
  if(!grams || !cost){
    $("lotPreview").textContent="กรอกจำนวนทองและเงินที่จ่ายเพื่อดูน้ำหนักทองและต้นทุนเฉลี่ย";
    return;
  }
  $("lotPreview").innerHTML=`น้ำหนักทองประมาณ <b>${num(grams,6)} g</b> (${num(grams/OZ_TO_GRAM,6)} oz) · ต้นทุนเฉลี่ย <b>${money(cost/grams)}/g</b>`;
}

function addLot(e){
  e.preventDefault();
  const q=Number($("quantity").value), cost=Number($("cost").value);
  const grams=unitToGrams(q,$("unit").value);
  if(!(q>0) || !(cost>0) || !(grams>0)){alert("กรุณากรอกจำนวนทองและเงินที่จ่ายให้ถูกต้อง");return;}
  const lots=loadLots();
  lots.push({
    id:crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    date:$("buyDate").value,
    time:$("buyTime").value,
    goldType:$("goldType").value,
    quantity:q,
    unit:$("unit").value,
    grams,
    costThb:cost,
    buyPriceThbGram:Number($("buyPrice").value)||null,
    buyFx:Number($("buyFx").value)||null,
    note:$("note").value.trim(),
    createdAt:new Date().toISOString()
  });
  saveLots(lots);
  $("lotForm").reset();
  $("buyDate").value=isoDate(new Date());
  renderPortfolio();renderLots();renderChart();
  alert("บันทึกรอบซื้อเรียบร้อยแล้ว");
}

function deleteLot(id){
  const lots=loadLots();
  const target=lots.find(x=>x.id===id);
  if(!target)return;
  if(!confirm(`ลบรอบซื้อวันที่ ${target.date} ใช่หรือไม่?`))return;
  saveLots(lots.filter(x=>x.id!==id));
  renderPortfolio();renderLots();renderChart();
}

function simulate(percent){
  const p=calculatePortfolio();
  const factor=percent/100;
  const grams=p.totalGrams*factor;
  const cost=p.totalCost*factor;
  const value=p.lots.reduce((sum,l)=>sum + l.value*factor,0);
  const pl=value-cost;
  $("simulateResult").innerHTML=`
    <div>จำลองขาย <b>${percent}%</b> · ${num(grams,6)} g</div>
    <div>ต้นทุนของส่วนที่ขายประมาณ <b>${money(cost)}</b></div>
    <div>มูลค่าขายโดยประมาณ <b>${money(value)}</b></div>
    <div class="big ${pl>=0?"positive-text":"negative-text"}">${pl>=0?"+":""}${money(pl)} (${pct(cost?pl/cost*100:0)})</div>
    <small>${getEffectiveSellPrice().exact?"ใช้ราคาขายจริงที่คุณกรอก":"ใช้ราคาตลาดประมาณจาก API และคำนึงถึงเปอร์เซ็นต์ทองของแต่ละ Lot"}</small>`;
}

function exportData(){
  const data={
    exportedAt:new Date().toISOString(),
    market:{
      spotUsdOz:state.spotUsdOz,usdThb:state.usdThb,
      priceThbGram:state.priceThbGram,priceThbOz:state.priceThbOz,
      updatedAt:state.updatedAt,source:state.source
    },
    lots:loadLots(),
    settings:loadSettings()
  };
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);a.download=`gold-portfolio-${isoDate(new Date())}.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

function clearAll(){
  if(!loadLots().length){alert("ยังไม่มีข้อมูลให้ลบ");return;}
  if(confirm("ต้องการลบรายการซื้อทองทั้งหมดในหน้านี้ใช่หรือไม่?")){
    localStorage.removeItem(STORAGE_KEY);renderPortfolio();renderLots();renderChart();
  }
}

function setup(){
  $("buyDate").value=isoDate(new Date());
  $("lotForm").addEventListener("submit",addLot);
  ["quantity","cost","unit"].forEach(id=>$(id).addEventListener("input",updateLotPreview));
  $("refreshGoldBtn").addEventListener("click",fetchGold);
  $("exportGoldBtn").addEventListener("click",exportData);
  $("clearGoldBtn").addEventListener("click",clearAll);

  document.querySelectorAll(".simulate-btn").forEach(btn=>{
    btn.addEventListener("click",()=>simulate(Number(btn.dataset.percent)));
  });

  document.querySelectorAll(".chart-tab[data-range]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      document.querySelectorAll(".chart-tab[data-range]").forEach(x=>x.classList.remove("active"));
      btn.classList.add("active");
      if(state.range!==btn.dataset.range){
        if(tvChart)saveChartView();
        state.range=btn.dataset.range;
        if(state.range!=="1D") chartInterval="1D";
        document.querySelectorAll(".chart-interval").forEach(x=>x.classList.toggle("active",x.dataset.interval===chartInterval));
        tvChartReadyKey=null;
      }
      renderChart();
      if(state.range!=="1D") fetchHistoricalGold();
    });
  });

  $("lotsList").addEventListener("click",e=>{
    const btn=e.target.closest(".delete-lot");
    if(btn)deleteLot(btn.dataset.id);
  });

  const settings=loadSettings();
  $("useSellOverride").checked=!!settings.useSellOverride;
  $("sellOverride").value=settings.sellOverride||"";
  $("useSellOverride").addEventListener("change",saveOverride);
  $("sellOverride").addEventListener("input",saveOverride);

  $("chartFitBtn").addEventListener("click",fitChart);
  $("chartResetBtn").addEventListener("click",resetChartZoom);
  $("chartFullscreenBtn").addEventListener("click",toggleChartFullscreen);
  $("chartCandleBtn").addEventListener("click",()=>{setChartMode(chartMode==="line"?"candle":"line");renderChart();});
  document.querySelectorAll(".chart-interval").forEach(btn=>btn.addEventListener("click",()=>setChartInterval(btn.dataset.interval)));

  window.addEventListener("resize",()=>{
    if(tvChart && $("goldChart")) tvChart.resize($("goldChart").clientWidth,$("goldChart").clientHeight);
    if(tvChartOz && $("goldChartOz")) tvChartOz.resize($("goldChartOz").clientWidth,$("goldChartOz").clientHeight);
    drawPurchaseOverlays();
  });
  loadLastMarket();
  renderPortfolio();
  renderLots();
  renderChart();
  fetchGold().then(()=>fetchHistoricalGold());
  state.timer=setInterval(fetchGold,POLL_MS);
  setTimeout(fetchHistoricalGold,2500);
}

function saveOverride(){
  const s=loadSettings();
  s.useSellOverride=$("useSellOverride").checked;
  s.sellOverride=Number($("sellOverride").value)||0;
  saveSettings(s);
  renderPortfolio();renderLots();
}

document.addEventListener("DOMContentLoaded",setup);
})();