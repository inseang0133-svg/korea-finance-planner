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

const OZ_TO_GRAM = 31.1034768;
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
let tvChartReadyRange = null;
let tvCrosshairBound = false;
const CHART_VIEW_KEY = "kfp_gold_chart_view_v1";

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

function formatDateTime(date, time){
  if(!date) return "-";
  const d = new Date(`${date}T${time || "00:00"}`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleString("th-TH",{dateStyle:"medium",timeStyle:time ? "short" : undefined});
}

function getEffectiveSellPrice(){
  const settings = loadSettings();
  if(settings.useSellOverride && Number(settings.sellOverride) > 0){
    return {price:Number(settings.sellOverride), exact:true};
  }
  return {price:state.priceThbGram || 0, exact:false};
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
      return thb?{ts,price:thb,source:"xaus-intraday"}:null;
    }).filter(Boolean).sort((a,b)=>a.ts-b.ts);
    if(rows.length){
      localStorage.setItem(INTRADAY_HISTORY_KEY,JSON.stringify(rows.slice(-1500)));
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
  history.push({ts:now,price:Number(state.priceThbGram)});
  const cutoff=now-31*86400000;
  saveHistory(history.filter(x=>x.ts>=cutoff).slice(-5000));
}
function loadDailyHistory(){try{return JSON.parse(localStorage.getItem(DAILY_HISTORY_KEY)||"[]")}catch{return []}}
function saveDailyHistory(rows){localStorage.setItem(DAILY_HISTORY_KEY,JSON.stringify(rows.slice(-400)))}
function ymd(d){return new Date(d).toISOString().slice(0,10)}

async function fetchHistoricalGold(){
  const now=new Date(), from=new Date(now.getTime()-31*86400000);
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
      return thb?{ts:new Date(`${date}T12:00:00Z`).getTime(),price:thb,date,source:"xaus-daily"}:null;
    }).filter(Boolean).filter(x=>x.ts>=from.getTime()).sort((a,b)=>a.ts-b.ts);
    if(rows.length){
      saveDailyHistory(rows);
      renderChart();
      const hint=$("chartHint");
      if(hint&&state.range!=="1D") hint.textContent=`ข้อมูลย้อนหลัง ${rows.length} วัน · XAU/USD × FX ปัจจุบัน (ประมาณ)`;
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
        return date&&Number.isFinite(usd)&&thb?{ts:new Date(`${date}T12:00:00Z`).getTime(),price:thb,date,source:"goldprice-daily"}:null;
      }).filter(Boolean).sort((a,b)=>a.ts-b.ts);
      if(rows.length){saveDailyHistory(rows);renderChart();return true;}
    }catch(_){ }
    const hint=$("chartHint");
    if(hint&&state.range!=="1D")hint.textContent="โหลดข้อมูลย้อนหลังไม่ได้ · แสดงข้อมูลที่เคยบันทึกไว้แทน";
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

function getChartPoints(){
  const now=Date.now();
  let pts=[];
  if(state.range==="1D"){
    const remote=(()=>{try{return JSON.parse(localStorage.getItem(INTRADAY_HISTORY_KEY)||"[]")}catch{return []}})();
    pts=remote.filter(x=>x.ts>=now-86400000&&Number.isFinite(Number(x.price)));
    pts=pts.concat(loadHistory().filter(x=>x.ts>=now-86400000&&Number.isFinite(Number(x.price))));
  }else{
    const days=state.range==="7D"?7:30,start=now-days*86400000;
    pts=loadDailyHistory().filter(x=>x.ts>=start&&Number.isFinite(Number(x.price)));
    const local=loadHistory().filter(x=>x.ts>=start&&Number.isFinite(Number(x.price)));
    if(local.length)pts=pts.concat(local.slice(-1));
  }
  const dedup=[];
  for(const p of pts){
    const item={ts:Number(p.ts),price:Number(p.price)};
    if(!Number.isFinite(item.ts)||!Number.isFinite(item.price)||item.price<=0)continue;
    const prev=dedup[dedup.length-1];
    if(prev&&Math.abs(prev.ts-item.ts)<60000)dedup[dedup.length-1]=item;
    else dedup.push(item);
  }
  return dedup.sort((a,b)=>a.ts-b.ts);
}

function loadChartViews(){
  try{return JSON.parse(localStorage.getItem(CHART_VIEW_KEY)||"{}")}catch{return {}}
}
function saveChartView(range){
  if(!tvChart)return;
  try{
    const visible=tvChart.timeScale().getVisibleRange();
    if(!visible)return;
    const views=loadChartViews();
    views[range]={from:visible.from,to:visible.to};
    localStorage.setItem(CHART_VIEW_KEY,JSON.stringify(views));
  }catch(_){ }
}
function restoreChartView(range,points){
  if(!tvChart||!points.length)return;
  const views=loadChartViews();
  const saved=views[range];
  try{
    if(saved && Number.isFinite(Number(saved.from)) && Number.isFinite(Number(saved.to))){
      tvChart.timeScale().setVisibleRange({from:saved.from,to:saved.to});
    }else{
      tvChart.timeScale().fitContent();
    }
  }catch(_){tvChart.timeScale().fitContent()}
}
function chartTime(ts){return Math.floor(Number(ts)/1000)}
function chartPointData(pts){
  const out=[]; let lastTime=0;
  for(const p of pts){
    const time=chartTime(p.ts), value=Number(p.price);
    if(!Number.isFinite(time)||!Number.isFinite(value)||value<=0)continue;
    if(time<=lastTime){
      if(time===lastTime) out[out.length-1]={time,value};
      continue;
    }
    out.push({time,value}); lastTime=time;
  }
  return out;
}
function ensureTradingViewChart(){
  if(tvChart) return true;
  if(!window.LightweightCharts){
    const hint=$("chartHint");
    if(hint)hint.textContent="กำลังโหลดระบบกราฟ…";
    return false;
  }
  const el=$("goldChart"); if(!el)return false;
  tvChart=LightweightCharts.createChart(el,{
    autoSize:true,
    layout:{background:{type:"solid",color:"#0f1112"},textColor:"#777"},
    grid:{vertLines:{color:"#171919"},horzLines:{color:"#292b2b"}},
    rightPriceScale:{borderColor:"#292b2b",scaleMargins:{top:0.08,bottom:0.08}},
    timeScale:{borderColor:"#292b2b",timeVisible:true,secondsVisible:false,rightOffset:5,barSpacing:5,minBarSpacing:2},
    crosshair:{mode:LightweightCharts.CrosshairMode.Normal,vertLine:{color:"#d4af37",width:1,style:2,labelBackgroundColor:"#8f7218"},horzLine:{color:"#d4af37",width:1,style:2,labelBackgroundColor:"#8f7218"}},
    handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},
    handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:true,axisDoubleClickReset:true},
    localization:{priceFormatter:v=>`฿${Number(v).toLocaleString("th-TH",{maximumFractionDigits:2})}`}
  });
  tvSeries=tvChart.addAreaSeries({
    topColor:"rgba(212,175,55,.24)",
    bottomColor:"rgba(212,175,55,.015)",
    lineColor:"#d4af37",
    lineWidth:2,
    priceLineVisible:true,
    lastValueVisible:true,
    crosshairMarkerVisible:true,
    crosshairMarkerRadius:4,
    priceFormat:{type:"price",precision:2,minMove:0.01}
  });
  tvChart.timeScale().subscribeVisibleTimeRangeChange(()=>saveChartView(state.range));
  tvChart.subscribeCrosshairMove(param=>{
    const tooltip=$("chartTooltip");
    if(!tooltip)return;
    if(!param.time || !param.seriesData || !tvSeries){return;}
    const row=param.seriesData.get(tvSeries);
    if(!row || !Number.isFinite(Number(row.value)))return;
    const d=new Date(Number(param.time)*1000);
    const dateText=state.range==="1D"
      ? d.toLocaleString("th-TH",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})
      : d.toLocaleDateString("th-TH",{day:"2-digit",month:"short",year:"numeric"});
    tooltip.textContent=`${dateText} · ${money(Number(row.value))}/g`;
  });
  return true;
}
function updateChartStats(pts){
  if(!pts.length){
    $("chartCurrent").textContent="ปัจจุบัน: -";
    $("chartHigh").textContent="สูงสุด: -";
    $("chartLow").textContent="ต่ำสุด: -";
    $("chartChange").textContent="เปลี่ยนแปลง: -";
    return;
  }
  const values=pts.map(x=>Number(x.price)).filter(Number.isFinite);
  const current=values[values.length-1],first=values[0],high=Math.max(...values),low=Math.min(...values);
  const change=first?((current-first)/first)*100:0;
  $("chartCurrent").textContent=`ปัจจุบัน: ${money(current)}/g`;
  $("chartHigh").textContent=`สูงสุด: ${money(high)}/g`;
  $("chartLow").textContent=`ต่ำสุด: ${money(low)}/g`;
  $("chartChange").textContent=`เปลี่ยนแปลง: ${change>=0?"+":""}${change.toFixed(2)}%`;
}
function renderChart(){
  const el=$("goldChart"); if(!el)return;
  const pts=getChartPoints();
  updateChartStats(pts);

  if(!ensureTradingViewChart())return;
  const data=chartPointData(pts);
  const hint=$("chartHint");
  if(!data.length){
    if(hint)hint.textContent=state.range==="1D"?"กำลังโหลดกราฟ 1D จาก XAUS…":"กำลังโหลดข้อมูลย้อนหลังจาก XAUS…";
    tvSeries.setData([]);
    return;
  }

  tvSeries.setData(data);
  if(tvChartReadyRange!==state.range){
    restoreChartView(state.range,data);
    tvChartReadyRange=state.range;
  }
  if(hint){
    hint.textContent=state.range==="1D"
      ?`ลาก/บีบนิ้วเพื่อเลื่อนและซูม · ${data.length.toLocaleString()} จุด`
      :`ลาก/บีบนิ้วเพื่อเลื่อนและซูม · ${data.length.toLocaleString()} จุด`;
  }
  const tooltip=$("chartTooltip");
  if(tooltip && !tooltip.textContent)tooltip.textContent="แตะ/ลากบนกราฟเพื่อดูราคา · Pinch เพื่อซูม";
}
function resetChartZoom(){
  if(!tvChart)return;
  const views=loadChartViews();
  delete views[state.range];
  localStorage.setItem(CHART_VIEW_KEY,JSON.stringify(views));
  tvChart.timeScale().fitContent();
}
function fitChart(){if(tvChart)tvChart.timeScale().fitContent()}
function toggleChartFullscreen(){
  const wrap=$("goldChart")?.closest(".chart-wrap"); if(!wrap)return;
  wrap.classList.toggle("chart-fullscreen");
  const btn=$("chartFullscreenBtn");
  if(btn)btn.textContent=wrap.classList.contains("chart-fullscreen")?"✕ ออกจากเต็มจอ":"⛶ เต็มจอ";
  setTimeout(()=>{if(tvChart)tvChart.resize($("goldChart").clientWidth,$("goldChart").clientHeight);},50);
}
function showChartPoint(clientX){
  // Kept for backward compatibility with older saved page code.
  if(tvChart){
    const rect=$("goldChart")?.getBoundingClientRect();
    if(rect){
      const x=Math.max(0,Math.min(rect.width,clientX-rect.left));
      tvChart.setCrosshairPosition(undefined,undefined,tvSeries);
    }
  }
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
  renderPortfolio();renderLots();
  alert("บันทึกรอบซื้อเรียบร้อยแล้ว");
}

function deleteLot(id){
  const lots=loadLots();
  const target=lots.find(x=>x.id===id);
  if(!target)return;
  if(!confirm(`ลบรอบซื้อวันที่ ${target.date} ใช่หรือไม่?`))return;
  saveLots(lots.filter(x=>x.id!==id));
  renderPortfolio();renderLots();
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
    localStorage.removeItem(STORAGE_KEY);renderPortfolio();renderLots();
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

  document.querySelectorAll(".chart-tab").forEach(btn=>{
    btn.addEventListener("click",()=>{
      document.querySelectorAll(".chart-tab").forEach(x=>x.classList.remove("active"));
      btn.classList.add("active");
      if(state.range!==btn.dataset.range){
        if(tvChart)saveChartView(state.range);
        state.range=btn.dataset.range;
        tvChartReadyRange=null;
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

  window.addEventListener("resize",()=>{
    if(tvChart && $("goldChart")) tvChart.resize($("goldChart").clientWidth,$("goldChart").clientHeight);
    renderChart();
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