(() => {
"use strict";

/*
  Gold Portfolio module
  - Isolated from index.html / script.js
  - LocalStorage only for portfolio records
  - Primary portfolio valuation: GOLD2go 96.5% "รับซื้อ" quote.
  - Auto quote: official InterGold public 96.5% bid feed, with a browser-readable proxy fallback.
  - Manual fallback + last-known cached quote are preserved; failed auto fetch never clears a valid price.
  - XAU/USD + USD/THB remains available as a separate market reference/chart
*/

const STORAGE_KEY = "kfp_gold_lots_v1";
const HISTORY_KEY = "kfp_gold_market_history_v1";
const SETTINGS_KEY = "kfp_gold_settings_v1";
const DAILY_HISTORY_KEY = "kfp_gold_daily_history_v2";
const INTRADAY_HISTORY_KEY = "kfp_gold_intraday_history_v2";

const OZ_TO_GRAM = 31.1034768;
const PURCHASE_TIMEZONE = "Asia/Seoul";
const BAHT_GOLD_GRAM = 15.244; // standard Thai gold-weight reference
// Smart polling:
// - visible page: every 5 seconds
// - hidden/background: every 45 seconds
// - after 429/403/timeout: back off for 45 seconds
// - after repeated failures: keep Last Known and slow down to 60 seconds
const POLL_VISIBLE_MS = 5_000;
const POLL_HIDDEN_MS = 45_000;
const POLL_BACKOFF_MS = 45_000;
const POLL_FAILURE_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
let pollTimer = null;
let pollBusy = false;
let gold2goConsecutiveFailures = 0;
let lastPollReason = "startup";
// GOLD2go official priceInfo endpoint discovered from the official app Network response.
// API sellPrice = app "รับซื้อ"; API buyPrice = app "ขายออก".
const GOLD2GO_API_URL = "https://gold2go-api.intergold.co.th/api/trade/priceInfo";
// GitHub Pages may be blocked by the API's CORS policy, so direct is attempted first,
// then this optional browser CORS proxy, then the legacy public-feed/cache fallback.
const GOLD2GO_CORS_PROXY = "https://corsproxy.io/?url=";
// (ไม่บังคับ) URL ของ Cloudflare Worker ส่วนตัวที่ forward ไป priceInfo — ดู gold2go-worker.js
// ถ้าใส่ค่า ระบบจะลองตัวนี้ก่อนเป็นอันดับแรก ซึ่งเสถียรที่สุดเพราะ API ต้นทางไม่เปิด CORS
const GOLD2GO_WORKER_URL = "";
const GOLD2GO_DIRECT_URL = "https://www.intergold.co.th/";
const GOLD2GO_PROXY_URL = "https://r.jina.ai/http://www.intergold.co.th/";
const GOLD2GO_AUTO_TIMEOUT_MS = 9000;
const GOLD2GO_MIN_MANUAL_GAP_MS = 60_000;
let lastGold2goAttemptAt = 0;

let state = {
  spotUsdOz: null,
  usdThb: null,
  priceThbGram: null,
  priceThbOz: null,
  thaiGold: { barBuy: null, barSell: null, jewelryBuy: null, jewelrySell: null, updatedAt: null, source: null },
  // GOLD2go's own 96.5% quotes. Names here follow the app labels, not API field names.
  gold2go: { receivePrice: null, sellPrice: null, updatedAt: null, source: null },
  updatedAt: null,
  source: null,
  range: "1D",
  timer: null
};

let chartMode = "line";
let chartInterval = "5m";
let selectedLotNumber = null;
const CHART_INTERVALS = {"5m":5*60*1000,"15m":15*60*1000,"30m":30*60*1000,"1H":60*60*1000,"1D":24*60*60*1000};

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
  const mode = settings.valuationSource === "market" ? "market" : "gold2go";
  const gold2goBuyBaht = Number(settings.gold2goBuyBaht);
  const marketPrice = Number(state.priceThbGram);

  // GOLD2go quote is entered exactly as shown in the app:
  // "รับซื้อ XX,XXX บาท / บาททอง". Convert to THB/gram only for
  // internal calculations; the displayed quote remains THB/บาททอง.
  if(mode === "gold2go" && Number.isFinite(gold2goBuyBaht) && gold2goBuyBaht > 0){
    return {
      mode:"gold2go",
      exact:true,
      source:"GOLD2go",
      pricePerBaht:gold2goBuyBaht,
      pricePerGram:gold2goBuyBaht / BAHT_GOLD_GRAM,
      updatedAt:settings.gold2goUpdatedAt || null
    };
  }

  return {
    mode:"market",
    exact:false,
    source:"market",
    price:Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : 0,
    pricePerGram:Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : 0,
    gold2goMissing:mode === "gold2go"
  };
}

function calculateLot(lot){
  const quote = getEffectiveSellPrice();
  const grams = Number(lot.grams) || 0;
  const cost = Number(lot.costThb) || 0;

  let value = 0;
  let valuationSource = quote.mode;

  if(quote.mode === "gold2go" && Number(lot.goldType || 99.99) === 96.5){
    // GOLD2go quotes its 96.5% gold in "บาททอง". This is the correct
    // valuation basis for a GOLD2go 96.5% holding.
    const bahtGold = lot.unit === "baht"
      ? (Number(lot.quantity) || 0)
      : grams / BAHT_GOLD_GRAM;
    value = bahtGold * quote.pricePerBaht;
  }else{
    // Non-GOLD2go lots continue to use the XAU/THB market estimate.
    const purity = Number(lot.goldType || 99.99) / 99.99;
    const marketPerGram = Number(state.priceThbGram) || 0;
    const sell = marketPerGram * purity;
    value = grams * sell;
    valuationSource = quote.mode === "gold2go" ? "market-fallback" : "market";
  }

  const pl = value - cost;
  const plPct = cost ? (pl / cost) * 100 : 0;
  const avgCost = grams ? cost / grams : 0;
  return {...lot, grams, cost, value, pl, plPct, avgCost, valuationSource};
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


function cleanGold2goPrice(v){
  const n=Number(String(v??"").replace(/,/g,"").replace(/[^\d.]/g,""));
  return Number.isFinite(n)&&n>5000&&n<500000 ? Math.round(n) : null;
}

// ขายออกต้องสูงกว่ารับซื้อเล็กน้อย (spread จริง ~150-200 บาท). ถ้าห่างเกิน 3% หรือต่ำกว่ารับซื้อ
// แปลว่าเป็นค่าค้างเก่า -> ไม่แสดง/ไม่ใช้ แทนที่จะโชว์ราคาที่ผิด
function sanitizeGold2goSell(receive, sell){
  const r=Number(receive), v=Number(sell);
  if(!(r>0) || !(v>0)) return null;
  if(v<=r || v>r*1.03) return null;
  return v;
}

// อ่านทั้งรับซื้อ+ขายออกจากหน้า public ของ InterGold (ใช้เมื่อ API หลักถูกบล็อก)
function parseGold2goPublicQuote(text){
  const receive=parseGold2goPublicPrice(text);
  if(!receive) return null;
  const raw=String(text||"");
  let sell=null;
  const askPatterns=[
    /(?:ask|offer|sell)Price96["'\]\s:=]+(\d[\d,]*(?:\.\d+)?)/i,
    /InterGold\s*96\.5%\s*\(Baht\)[^\d]{0,140}[\d,]+(?:\.\d+)?\s*[|｜]\s*([\d,]+(?:\.\d+)?)/i
  ];
  for(const re of askPatterns){
    const m=raw.match(re);
    const n=sanitizeGold2goSell(receive, cleanGold2goPrice(m?.[1]));
    if(n){ sell=n; break; }
  }
  return {receivePrice:receive, sellPrice:sell};
}

function parseGold2goPublicPrice(text){
  if(!text) return null;
  const raw=String(text);

  // InterGold public pages expose the structured 96.5% bid quote.
  const fieldPatterns=[
    /bidPrice96["'\]\s:=]+(\d[\d,]*(?:\.\d+)?)/i,
    /"bidPrice96"\s*:\s*(\d+(?:\.\d+)?)/i,
    /bidPrice96\s*[:=]\s*(\d+(?:\.\d+)?)/i
  ];
  for(const re of fieldPatterns){
    const m=raw.match(re);
    const n=cleanGold2goPrice(m?.[1]);
    if(n) return n;
  }

  // Fallback for the rendered table:
  // InterGold 96.5% (Baht) | รับซื้อ | ขายออก
  const rowPatterns=[
    /InterGold\s*96\.5%\s*\(Baht\)[^\d]{0,140}([\d,]+(?:\.\d+)?)\s*[|｜]\s*([\d,]+(?:\.\d+)?)/i,
    /InterGold\s*96\.5%[^\d]{0,100}([\d,]+(?:\.\d+)?)/i
  ];
  for(const re of rowPatterns){
    const m=raw.match(re);
    const n=cleanGold2goPrice(m?.[1]);
    if(n) return n;
  }
  return null;
}

function updateGold2goQuoteUI(){
  const s=loadSettings();
  const value=Number(s.gold2goBuyBaht);
  const status=$("gold2goQuoteStatus");
  const mode=$("gold2goPriceMode");

  if(!status) return;

  if(value>0){
    const when=s.gold2goUpdatedAt
      ? new Date(s.gold2goUpdatedAt).toLocaleString("th-TH",{dateStyle:"short",timeStyle:"short"})
      : "-";
    const isManual=s.gold2goPriceMode==="manual";
    const isApi=s.gold2goPriceMode==="auto" && String(s.gold2goPriceSource||"").includes("GOLD2go API");
    const label=isManual ? "✏️ Manual" : (isApi ? "🟢 GOLD2go API" : "🟡 Last known");
    status.className=`gold2go-status ${isManual?"manual":"cached"}`;
    status.innerHTML=`${label} · <b>${money(value)}/บาททอง</b> · ${when}`;

    if(mode){
      mode.textContent=isManual
        ? "✏️ Manual · ใช้ราคาที่คุณกรอก"
        : (isApi ? "🟢 GOLD2go API · อัปเดตอัตโนมัติ" : "🟡 Last known · Auto จะพยายามอัปเดตอีกครั้ง");
    }
  }else{
    status.className="gold2go-status warning";
    status.innerHTML="⚠️ ยังไม่มีราคา GOLD2go · ระบบจะลอง Auto และคุณสามารถกรอกเองได้";
    if(mode) mode.textContent="⚠️ ยังไม่มีราคา";
  }
}

function saveGold2goAutoPrice(value, source, sellValue){
  const s=loadSettings();
  s.valuationSource="gold2go";
  s.gold2goBuyBaht=value;
  s.gold2goReceiveBaht=value;
  s.gold2goUpdatedAt=new Date().toISOString();
  s.gold2goPriceMode="auto";
  s.gold2goPriceSource=source;
  // ห้ามเก็บค่า "ขายออก" เก่าค้างไว้ข้ามรอบ: ถ้ารอบนี้ไม่ได้ค่าใหม่ ให้ล้างทิ้ง
  const freshSell=sanitizeGold2goSell(value, sellValue);
  if(freshSell) s.gold2goSellBaht=freshSell; else delete s.gold2goSellBaht;
  saveSettings(s);
  state.gold2go={
    receivePrice:value,
    sellPrice:freshSell,
    updatedAt:s.gold2goUpdatedAt || null,
    source
  };

  const input=$("gold2goBuyBaht");
  if(input) input.value=value;

  const status=$("gold2goQuoteStatus");
  if(status){
    status.className="gold2go-status success";
    status.innerHTML=`🟢 <b>Auto</b> · ${money(value)}/บาททอง · อัปเดต ${new Date(s.gold2goUpdatedAt).toLocaleString("th-TH",{dateStyle:"short",timeStyle:"short"})}`;
  }

  const mode=$("gold2goPriceMode");
  if(mode) mode.textContent="🟢 Auto · ราคาจาก InterGold public feed";
  renderGold2goMarketUI();
}

function setGold2goFallbackStatus(message){
  const s=loadSettings();
  const hasLast=Number(s.gold2goBuyBaht)>0;
  const status=$("gold2goQuoteStatus");
  if(status){
    status.className=`gold2go-status ${hasLast?"cached":"warning"}`;
    if(hasLast){
      const when=s.gold2goUpdatedAt
        ? new Date(s.gold2goUpdatedAt).toLocaleString("th-TH",{dateStyle:"short",timeStyle:"short"})
        : "-";
      const label=s.gold2goPriceMode==="manual" ? "✏️ Manual" :
        (String(s.gold2goPriceSource||"").includes("GOLD2go API") ? "🟢 API Cache" : "🟡 Cache");
      status.innerHTML=`${label} · <b>${money(Number(s.gold2goBuyBaht))}/บาททอง</b> · ล่าสุด ${when}<br><small>Auto ดึงราคาไม่สำเร็จ: ${esc(message)}</small>`;
    }else{
      status.innerHTML=`⚠️ <b>Auto ยังดึงราคาไม่ได้</b><br><small>${esc(message)}</small>`;
    }
  }
  const mode=$("gold2goPriceMode");
  if(mode) mode.textContent=hasLast
    ? "🟡 ใช้ราคาล่าสุดที่บันทึกไว้ · Auto จะลองใหม่อัตโนมัติ"
    : "⚠️ ยังไม่มีราคา · กรอกเองได้";
}

function normalizeGold2goApiResult(data){
  const result=data?.result;
  if(!result || data?.responseStatus?.status !== "SUCCESS") return null;

  // Verified from the Network response:
  // sellPrice = 70971 is shown by the app as "รับซื้อ"
  // buyPrice  = 71151 is shown by the app as "ขายออก"
  const receivePrice=cleanGold2goPrice(result.sellPrice);
  const sellPrice=cleanGold2goPrice(result.buyPrice);
  if(!(receivePrice>0) || !(sellPrice>0)) return null;

  return {
    receivePrice,
    sellPrice,
    updatedAt: result.lastUpdated || new Date().toISOString(),
    source: "GOLD2go API · priceInfo"
  };
}

async function fetchGold2goApiDirect(){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),GOLD2GO_AUTO_TIMEOUT_MS);
  try{
    const response=await fetch(GOLD2GO_API_URL,{
      method:"POST",
      cache:"no-store",
      signal:controller.signal,
      headers:{
        "Accept":"application/json",
        "Content-Type":"application/json"
      },
      body:"{}"
    });
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const data=await response.json();
    const quote=normalizeGold2goApiResult(data);
    if(!quote) throw new Error("API ตอบกลับสำเร็จแต่ไม่พบราคา 96.5%");
    return quote;
  }finally{
    clearTimeout(timer);
  }
}

async function fetchGold2goApiViaWorker(){
  if(!GOLD2GO_WORKER_URL) throw new Error("ไม่ได้ตั้งค่า Worker");
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),GOLD2GO_AUTO_TIMEOUT_MS);
  try{
    const response=await fetch(GOLD2GO_WORKER_URL,{cache:"no-store",signal:controller.signal});
    if(!response.ok) throw new Error(`Worker HTTP ${response.status}`);
    const quote=normalizeGold2goApiResult(await response.json());
    if(!quote) throw new Error("Worker ตอบกลับแต่ไม่พบราคา 96.5%");
    return {...quote,source:"GOLD2go API · Worker"};
  }finally{ clearTimeout(timer); }
}

async function fetchGold2goApiViaProxy(){
  const target=encodeURIComponent(GOLD2GO_API_URL);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),GOLD2GO_AUTO_TIMEOUT_MS);
  try{
    const response=await fetch(`${GOLD2GO_CORS_PROXY}${target}`,{
      method:"POST",
      cache:"no-store",
      signal:controller.signal,
      headers:{
        "Accept":"application/json",
        "Content-Type":"application/json"
      },
      body:"{}"
    });
    if(!response.ok) throw new Error(`Proxy HTTP ${response.status}`);
    const data=await response.json();
    const quote=normalizeGold2goApiResult(data);
    if(!quote) throw new Error("Proxy ตอบกลับแต่ไม่พบราคา 96.5%");
    return {...quote,source:"GOLD2go API · CORS proxy"};
  }finally{
    clearTimeout(timer);
  }
}

function saveGold2goApiQuote(quote){
  const s=loadSettings();
  s.valuationSource="gold2go";
  s.gold2goBuyBaht=quote.receivePrice;
  s.gold2goReceiveBaht=quote.receivePrice;
  s.gold2goSellBaht=quote.sellPrice;
  s.gold2goUpdatedAt=quote.updatedAt || new Date().toISOString();
  s.gold2goPriceMode="auto";
  s.gold2goPriceSource=quote.source;
  saveSettings(s);

  state.gold2go={
    receivePrice:quote.receivePrice,
    sellPrice:quote.sellPrice,
    updatedAt:quote.updatedAt || null,
    source:quote.source
  };

  const input=$("gold2goBuyBaht");
  if(input) input.value=quote.receivePrice;

  renderGold2goMarketUI();
  updateGold2goQuoteUI();
}

function renderGold2goMarketUI(){
  const receive=$("gold2goReceivePrice");
  const sell=$("gold2goSellPrice");
  const updated=$("gold2goMarketUpdated");
  const source=$("gold2goMarketSource");
  const q=state.gold2go||{};

  if(receive) receive.textContent=Number.isFinite(q.receivePrice) ? money(q.receivePrice) : "-";
  if(sell) sell.textContent=Number.isFinite(q.sellPrice) ? money(q.sellPrice) : "-";
  if(updated){
    updated.textContent=q.updatedAt
      ? `อัปเดต ${new Date(q.updatedAt.replace(" ","T")+(q.updatedAt.includes("Z")?"":"")).toLocaleString("th-TH",{dateStyle:"short",timeStyle:"short"})}`
      : "ยังไม่มีข้อมูล";
  }
  if(source){
    source.textContent=q.source ? `Source: ${q.source}` : "Source: GOLD2go API";
  }
}

async function fetchGold2goAutoPrice(force=false){
  // Manual mode is an explicit user choice. Automatic polling must never
  // overwrite a manual quote unless the user presses "ดึงราคา Auto".
  const now=Date.now();
  if(!force && lastGold2goAttemptAt &&
     (now-lastGold2goAttemptAt) < GOLD2GO_MIN_MANUAL_GAP_MS){
    return {ok:false,skipped:true,reason:"rate-limited"};
  }

  const currentSettings=loadSettings();
  if(!force && currentSettings.gold2goPriceMode==="manual"){
    return {ok:false,skipped:true,reason:"manual mode"};
  }

  lastGold2goAttemptAt=now;
  const errors=[];

  // LEVEL 0: Worker ส่วนตัว (ถ้าตั้งค่าไว้)
  if(GOLD2GO_WORKER_URL){
    try{
      const quote=await fetchGold2goApiViaWorker();
      saveGold2goApiQuote(quote);
      renderPortfolio();
      renderLots();
      return {ok:true,price:quote.receivePrice,receivePrice:quote.receivePrice,sellPrice:quote.sellPrice,source:quote.source};
    }catch(e){
      errors.push(`GOLD2go Worker: ${e?.name==="AbortError"?"timeout":(e?.message||"unavailable")}`);
    }
  }

  // LEVEL 1: GOLD2go's own priceInfo API.
  try{
    const quote=await fetchGold2goApiDirect();
    saveGold2goApiQuote(quote);
    renderPortfolio();
    renderLots();
    return {
      ok:true,
      price:quote.receivePrice,
      receivePrice:quote.receivePrice,
      sellPrice:quote.sellPrice,
      source:quote.source
    };
  }catch(e){
    errors.push(`GOLD2go API Direct: ${e?.name==="AbortError"?"timeout":(e?.message||"CORS/blocked")}`);
  }

  // LEVEL 1b: browser CORS proxy for the same official API.
  try{
    const quote=await fetchGold2goApiViaProxy();
    saveGold2goApiQuote(quote);
    renderPortfolio();
    renderLots();
    return {
      ok:true,
      price:quote.receivePrice,
      receivePrice:quote.receivePrice,
      sellPrice:quote.sellPrice,
      source:quote.source
    };
  }catch(e){
    errors.push(`GOLD2go API Proxy: ${e?.name==="AbortError"?"timeout":(e?.message||"unavailable")}`);
  }

  // LEVEL 1c: legacy/public feed fallback.
  const urls=[
    `${GOLD2GO_DIRECT_URL}?kfp=${Date.now()}`,
    `${GOLD2GO_PROXY_URL}?t=${Date.now()}`
  ];

  for(let i=0;i<urls.length;i++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),GOLD2GO_AUTO_TIMEOUT_MS);
    try{
      const response=await fetch(urls[i],{
        cache:"no-store",
        signal:controller.signal,
        headers:i===0
          ? {"Accept":"text/html,application/xhtml+xml"}
          : {"Accept":"text/plain,text/html,*/*"}
      });
      if(!response.ok) throw new Error(`HTTP ${response.status}`);

      const text=await response.text();
      const pub=parseGold2goPublicQuote(text);
      const price=pub?.receivePrice;
      if(!(price>0)) throw new Error("ไม่พบราคา InterGold 96.5% รับซื้อ");

      saveGold2goAutoPrice(
        price,
        i===0 ? "InterGold public feed · direct" : "InterGold public feed · proxy",
        pub.sellPrice
      );
      renderPortfolio();
      renderLots();
      return {
        ok:true,
        price,
        source:i===0 ? "InterGold public feed · direct" : "InterGold public feed · proxy"
      };
    }catch(e){
      errors.push(
        i===0
          ? `Direct: ${e?.name==="AbortError"?"timeout":(e?.message||"CORS/blocked")}`
          : `Proxy: ${e?.name==="AbortError"?"timeout":(e?.message||"unavailable")}`
      );
    }finally{
      clearTimeout(timer);
    }
  }

  // Never clear a valid price. Keep Last Known and expose Manual fallback.
  const errorMessage=errors.join(" · ");
  setGold2goFallbackStatus(errorMessage);
  renderPortfolio();
  renderLots();

  return {
    ok:false,
    error:errorMessage,
    hardBackoff:/\b(429|403)\b|timeout/i.test(errorMessage),
    errors
  };
}

function useManualGold2goPrice(){
  const value=Number($("gold2goBuyBaht")?.value);
  if(!(value>0)){
    alert(`กรุณากรอกราคา GOLD2go "รับซื้อ" เช่น 70971 บาท/บาททอง`);
    return false;
  }

  const s=loadSettings();
  s.valuationSource="gold2go";
  s.gold2goBuyBaht=value;
  s.gold2goUpdatedAt=new Date().toISOString();
  s.gold2goPriceMode="manual";
  s.gold2goPriceSource="Manual";
  saveSettings(s);

  const status=$("gold2goQuoteStatus");
  if(status){
    status.className="gold2go-status manual";
    status.innerHTML=`✏️ <b>Manual</b> · ${money(value)}/บาททอง · บันทึก ${new Date(s.gold2goUpdatedAt).toLocaleString("th-TH",{dateStyle:"short",timeStyle:"short"})}`;
  }
  const mode=$("gold2goPriceMode");
  if(mode) mode.textContent="✏️ Manual · ใช้ราคาที่คุณกรอก";
  state.gold2go={
    receivePrice:value,
    sellPrice:sanitizeGold2goSell(value, s.gold2goSellBaht),
    updatedAt:s.gold2goUpdatedAt,
    source:"Manual"
  };
  renderGold2goMarketUI();

  renderPortfolio();
  renderLots();
  return true;
}

async function fetchThaiGoldPrices(){
  // Thai retail reference: Gold Traders Association data.
  // Primary: public wrapper. Fallback: a JSON mirror using the same GTA data.
  const clean=v=>{
    const n=Number(String(v??"").replace(/,/g,""));
    return Number.isFinite(n)&&n>0?n:null;
  };

  // 1) Primary public wrapper
  try{
    const data=await fetchJSON(`https://api.chnwt.dev/thai-gold-api/latest?fresh=${Date.now()}`);
    const p=data?.response?.price||{};
    const bar=p.gold_bar||{};
    const jewelry=p.gold||{};
    const next={
      barBuy:clean(bar.buy),
      barSell:clean(bar.sell),
      jewelryBuy:clean(jewelry.buy),
      jewelrySell:clean(jewelry.sell),
      updatedAt:data?.response?.update_date||null,
      source:"สมาคมค้าทองคำ · public API"
    };
    if(next.barBuy||next.barSell||next.jewelryBuy||next.jewelrySell){
      state.thaiGold=next;
      localStorage.setItem("kfp_gold_thai_prices_v1",JSON.stringify(next));
      renderMarket();
      return true;
    }
    throw new Error("Thai gold API returned no prices");
  }catch(primaryError){
    // 2) Fallback JSON mirror. It exposes the same GTA prices in a browser-readable format.
    try{
      const data=await fetchJSON(`https://script.google.com/macros/s/AKfycbwgvstkxFOR9p6zOV2d8iEGagbpQ6h8C3BhPnDCoB56jvmbAwSG0A9a36r6oRxNkBXQ/exec?fresh=${Date.now()}`);
      const rows=Array.isArray(data?.data)?data.data:[];
      const find=(label,kind)=>rows.find(x=>x?.sellPriceGoldBar===label && (!kind || x?.taxBasePrice===kind));
      const time=find("เวลา")?.buyPriceGoldOrnament||null;
      const barSell=find("ราคาขายออก","ทองคำแท่ง 96.5%")?.buyPriceGoldOrnament;
      const barBuy=find("รับซื้อ")?.buyPriceGoldOrnament;
      const jewelrySell=find("ราคาขายออก","ทองรูปพรรณ 96.5%")?.buyPriceGoldOrnament;
      const jewelryBuy=find("ฐานภาษี")?.buyPriceGoldOrnament;
      const next={
        barBuy:clean(barBuy),
        barSell:clean(barSell),
        jewelryBuy:clean(jewelryBuy),
        jewelrySell:clean(jewelrySell),
        updatedAt:time,
        source:"สมาคมค้าทองคำ · fallback API"
      };
      if(next.barBuy||next.barSell||next.jewelryBuy||next.jewelrySell){
        state.thaiGold=next;
        localStorage.setItem("kfp_gold_thai_prices_v1",JSON.stringify(next));
        renderMarket();
        return true;
      }
      throw new Error("fallback returned no prices");
    }catch(_){
      // 3) Keep the last successful Thai retail quote instead of showing blank cards.
      try{
        const cached=JSON.parse(localStorage.getItem("kfp_gold_thai_prices_v1")||"null");
        if(cached && typeof cached==="object") state.thaiGold={...state.thaiGold,...cached,source:`${cached.source||"GTA"} · cached`};
      }catch(__){}
      renderMarket();
      return false;
    }
  }
}

async function fetchGold(){
  // GOLD2go is fetched as part of the smart polling cycle.
  // If it fails, its last valid quote remains active.
  const gold2goResult=await fetchGold2goAutoPrice();

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
    fetchThaiGoldPrices();
    return {ok:true,gold2go:gold2goResult};
  }catch(e){
    errors.push(`XAUS: ${e.message}`);
  }

  try{
    const data=await fetchJSON(`https://api.gold-api.com/price/XAU?fresh=${Date.now()}`);
    const spot=Number(data?.price);
    if(!Number.isFinite(spot)||spot<=0) throw new Error("invalid Gold API price");
    const fxData=await fetchJSON("https://api.frankfurter.app/latest?from=USD&to=THB");
    const fx=Number(fxData?.rates?.THB);
    if(!Number.isFinite(fx)||fx<=0) throw new Error("invalid USD/THB");
    applyMarket(spot,fx,"Gold API + Frankfurter");
    await fetchIntradayGold();
    fetchThaiGoldPrices();
    return {ok:true,gold2go:gold2goResult};
  }catch(e){
    errors.push(`Gold API: ${e.message}`);
  }

  setMarketOffline(errors.join(" | ")||"API unavailable");
  return {ok:false,error:errors.join(" | "),gold2go:gold2goResult};
}

// ปุ่ม 🔄 อัปเดต: ดึงราคาแล้วแจ้งผลเป็นข้อความสีเขียว (เวลา + ราคาตอนกด)
async function manualRefreshGold(){
  const btn=$("refreshGoldBtn"), note=$("refreshNotice");
  if(!btn || btn.disabled) return;
  const oldText=btn.textContent;
  btn.disabled=true; btn.textContent="⏳ กำลังอัปเดต...";
  if(note){ note.className="refresh-notice pending"; note.textContent="กำลังดึงราคาล่าสุด…"; }
  let res;
  try{ res=await fetchGold(); }catch(e){ res={ok:false,error:e?.message}; }
  btn.disabled=false; btn.textContent=oldText;
  if(!note) return;
  const t=new Date().toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
  if(res?.ok){
    const parts=[];
    if(state.spotUsdOz>0) parts.push(`ทองโลก $${num(state.spotUsdOz,2)}/oz`);
    if(state.priceThbGram>0) parts.push(`${money(state.priceThbGram)}/g`);
    const q=getEffectiveSellPrice();
    if(q.mode==="gold2go" && q.exact && q.pricePerBaht>0) parts.push(`GOLD2go รับซื้อ ${money(q.pricePerBaht)}/บาททอง`);
    note.className="refresh-notice ok";
    note.textContent=`✅ อัปเดตแล้ว เวลา ${t} น.${parts.length?" · "+parts.join(" · "):""}`;
  }else{
    note.className="refresh-notice fail";
    note.textContent=`⚠️ อัปเดตไม่สำเร็จ เวลา ${t} น. · ใช้ราคาล่าสุดที่บันทึกไว้`;
  }
}

function persistLastMarket(){
  localStorage.setItem("kfp_gold_last_market",JSON.stringify({
    spotUsdOz:state.spotUsdOz,usdThb:state.usdThb,
    priceThbOz:state.priceThbOz,priceThbGram:state.priceThbGram,
    updatedAt:state.updatedAt,source:state.source,thaiGold:state.thaiGold
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
      state={...state,...x,priceThbGram:Number(x.priceThbGram),priceThbOz:Number(x.priceThbOz),thaiGold:x.thaiGold||state.thaiGold};
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

  const tg=state.thaiGold||{};
  $("thaiBarBuy").textContent=Number.isFinite(tg.barBuy) ? money(tg.barBuy) : "-";
  $("thaiBarSell").textContent=Number.isFinite(tg.barSell) ? money(tg.barSell) : "-";
  $("thaiJewelryBuy").textContent=Number.isFinite(tg.jewelryBuy) ? money(tg.jewelryBuy) : "-";
  $("thaiJewelrySell").textContent=Number.isFinite(tg.jewelrySell) ? money(tg.jewelrySell) : "-";
  renderGold2goMarketUI();
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
function saveDailyHistory(rows){localStorage.setItem(DAILY_HISTORY_KEY,JSON.stringify(rows.slice(-400)))}
function ymd(d){return new Date(d).toISOString().slice(0,10)}

const GOLD_SNAPSHOT_KEY="kfp_gold_portfolio_snapshot_v1";
// เก็บสรุปมูลค่าพอร์ตล่าสุดไว้ให้หน้า index แสดง (อ่านอย่างเดียว ไม่ซิงก์ขึ้น Cloud)
function saveGoldSnapshot(p){
  try{
    if(!p.lots.length){ localStorage.removeItem(GOLD_SNAPSHOT_KEY); return; }
    if(!(Number.isFinite(p.currentValue) && p.currentValue>0)) return; // ยังไม่มีราคา -> เก็บค่าเดิมไว้
    localStorage.setItem(GOLD_SNAPSHOT_KEY,JSON.stringify({
      value:p.currentValue,cost:p.totalCost,pl:p.netPL,pct:p.netPLPct,
      lots:p.lots.length,grams:p.totalGrams,ts:Date.now()
    }));
  }catch(_){}
}

function renderPortfolio(){
  const p=calculatePortfolio();
  saveGoldSnapshot(p);
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
    if(sellQuote.mode === "gold2go" && sellQuote.exact){
      const updated = sellQuote.updatedAt
        ? ` · อัปเดต ${new Date(sellQuote.updatedAt).toLocaleString("th-TH",{dateStyle:"short",timeStyle:"short"})}`
        : "";
      valueHint.textContent=`GOLD2go รับซื้อ ${money(sellQuote.pricePerBaht)}/บาททอง${updated}`;
    }else if(sellQuote.gold2goMissing){
      valueHint.textContent="ยังไม่มีราคา GOLD2go · ใช้ตลาด XAU/THB ประมาณการชั่วคราว";
    }else{
      valueHint.textContent=`ตลาด XAU/THB ประมาณ ${money(sellQuote.pricePerGram)}/g`;
    }
  }
  $("winRate").textContent=`${p.wins} / ${p.lots.length}`;
  $("winRatePct").textContent=p.lots.length ? `${(p.wins/p.lots.length*100).toFixed(2)}%` : "0.00%";

  const card=$("netPLCard");
  card.classList.toggle("positive",p.netPL>0);
  card.classList.toggle("negative",p.netPL<0);
}

function getLotWindow(total, selected){
  if(total <= 3) return {start:1,end:total};
  let center=Math.max(1,Math.min(total,Number(selected)||total));
  let start=center-1;
  let end=center+1;
  if(start<1){start=1;end=3;}
  if(end>total){end=total;start=total-2;}
  return {start,end};
}

function renderLotNavigator(total){
  const nav=$("lotNavigator"), select=$("lotPageSelect"), hint=$("lotPageHint");
  if(!nav || !select) return;
  if(!total){
    nav.hidden=true;
    return;
  }
  nav.hidden=false;
  if(!selectedLotNumber || selectedLotNumber>total) selectedLotNumber=total;
  const current=String(selectedLotNumber);
  // Rebuild only when the round count changes, so the select does not jump while prices refresh.
  if(select.dataset.total!==String(total)){
    select.innerHTML=Array.from({length:total},(_,i)=>{
      const n=i+1;
      return `<option value="${n}">รอบ #${String(n).padStart(3,"0")}</option>`;
    }).join("");
    select.dataset.total=String(total);
  }
  select.value=current;
  const w=getLotWindow(total,selectedLotNumber);
  hint.textContent=total<=3 ? `แสดง ${total} รอบทั้งหมด` : `กำลังดูรอบ #${String(selectedLotNumber).padStart(3,"0")} · แสดง #${String(w.start).padStart(3,"0")}–#${String(w.end).padStart(3,"0")}`;
}

function lotEntryHTML(l){
  // Entry / break-even prices, all derived from the "per baht-weight" price shown in the GOLD2go app.
  const bahtWeight=l.unit === "baht" ? (Number(l.quantity) || 0) : (Number(l.grams) || 0) / BAHT_GOLD_GRAM;
  const cost=Number(l.cost) || 0;
  const purity=(Number(l.goldType) || 96.5) / 100;
  const fx=Number(state.usdThb);
  // break-even: value = bahtWeight x price = cost  ->  P/L = 0.00
  const breakEven=bahtWeight > 0 && cost > 0 ? cost / bahtWeight : 0;
  const enteredBaht=Number(l.entryBahtPrice) > 0 ? Number(l.entryBahtPrice) : 0;
  const entryBaht=enteredBaht || breakEven;
  const toOz=baht => (baht > 0 && fx > 0) ? baht / (BAHT_GOLD_GRAM * purity / OZ_TO_GRAM) / fx : 0;
  const col=(label,baht,approx)=>{
    const oz=toOz(baht);
    return `<div class="lot-entry-col">
      <em class="lot-entry-label">${label}</em>
      <b>${baht > 0 ? (approx ? "≈ " : "") + money(baht) : "-"}</b><em>/ บาททอง</em>
      <span class="lot-entry-oz">${oz > 0 ? "≈ " + formatUsdPrice(oz) + " / troy oz" : "troy oz: รอราคา USD/THB"}</span>
    </div>`;
  };
  let gap="";
  const q=getEffectiveSellPrice();
  if(q.mode === "gold2go" && q.exact && breakEven > 0 && purity === 0.965){
    const diff=q.pricePerBaht - breakEven;
    gap=`<div class="lot-entry-gap ${diff >= 0 ? "up" : "down"}">GOLD2go รับซื้อตอนนี้ ${money(q.pricePerBaht)} · ${
      Math.abs(diff) < 0.005 ? "ตรงจุดคุ้มทุนพอดี" : diff > 0 ? "สูงกว่าจุดคุ้มทุน " + money(diff) : "ต่ำกว่าจุดคุ้มทุน " + money(-diff)
    }</div>`;
  }
  return `<div class="lot-entry">
    <div class="lot-entry-cols${Math.abs(entryBaht - breakEven) < 1 ? " single" : ""}">${
      Math.abs(entryBaht - breakEven) < 1
        ? col("เข้าซื้อที่ = จุดคุ้มทุน (P/L 0.00)", breakEven, !enteredBaht)
        : col("เข้าซื้อที่", entryBaht, !enteredBaht) + col("จุดคุ้มทุน · P/L 0.00", breakEven, false)
    }</div>
    ${gap}
    <div class="lot-entry-note">troy oz แปลงย้อนกลับจากราคาต่อบาททอง ด้วย USD/THB ปัจจุบัน (ประมาณการ)</div>
  </div>`;
}

function renderLots(){
  const p=calculatePortfolio();
  $("lotSummary").textContent=p.lots.length
    ? `ทั้งหมด ${p.lots.length} รอบ · 🟢 ${p.wins} รอบกำไร · 🔴 ${p.losses} รอบขาดทุน`
    : "";
  const box=$("lotsList");
  if(!p.lots.length){
    renderLotNavigator(0);
    box.innerHTML=`<div class="empty-state">ยังไม่มีรายการซื้อ<br>เริ่มจากบันทึกรอบแรกด้านบนได้เลย</div>`;
    return;
  }

  renderLotNavigator(p.lots.length);
  const w=getLotWindow(p.lots.length,selectedLotNumber);
  const display=p.lots.slice(w.start-1,w.end).reverse();

  box.innerHTML=display.map(l=>{
    const roundNumber=p.lots.indexOf(l)+1;
    const cls=l.pl>0?"positive":l.pl<0?"negative":"";
    const text=l.pl>0?"positive-text":l.pl<0?"negative-text":"neutral-text";
    const status=l.pl>0?"🟢 กำไร":l.pl<0?"🔴 ขาดทุน":"⚪ จุดคุ้มทุน";
    return `
      <article class="lot-item ${cls}">
        <div class="lot-main">
          <div>
            <div class="lot-title">#${String(roundNumber).padStart(3,"0")} · ${l.goldType||"99.99"}% · ${status}</div>
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
          <div class="lot-cell lot-entry-cell">${lotEntryHTML(l)}</div>
        </div>
        ${l.note ? `<div class="lot-note">📝 ${escapeHTML(l.note)}</div>` : ""}
        <div class="lot-actions"><button class="delete-lot" data-id="${l.id}">ลบรอบนี้</button></div>
      </article>`;
  }).join("");
}

function escapeHTML(s){
  return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}

/* =========================================================================
   Gold chart — ONE chart: Gold Spot USD / troy oz
   Rewritten for stability:
   - Data kept in USD (no THB/FX mixing) in two stores:
       ticks  : 1-minute samples (live polling + XAUS intraday), 35 days
       daily  : daily OHLC bars (XAUS history / goldprice.dev), 400 days
   - Every range/interval/mode switch rebuilds the series from scratch
     (strictly ascending, de-duplicated times -> setData never throws)
   - Live ticks only call series.update() on the last 1-2 bars, and never
     touch the user's zoom/scroll position
   - Full history is loaded, the range button only decides the visible window,
     so the user can always scroll back (fixLeftEdge -> no empty void)
   - Reset / Fit / Fullscreen only touch the view, never the data
   ========================================================================= */
const USD_TICKS_KEY = "kfp_gold_usd_ticks_v3";
const USD_DAILY_KEY = "kfp_gold_usd_daily_v3";
const TICK_RES_MS = 60_000;
const TICK_KEEP_MS = 35 * 86400000;
const RANGE_DAYS = { "1D": 1, "7D": 7, "30D": 30 };
const TARGET_MAX_BARS = 400;

let tickMap = null;          // Map<bucketMs, usd>
let tickArr = null;          // sorted [bucketMs, usd]
let tickLastSave = 0, tickDirty = false;
let dailyBars = null;        // [{time,open,high,low,close}] time = 12:00 UTC of the date
let lastIntradayFetch = 0, lastHistoryFetch = 0;

let chart = null, areaSeries = null, candleSeries = null;
let chartBars = [];
let chartKey = "";
let chartRetryTimer = null;
let overlayRaf = 0;
let chartInfo = { firstIntradaySec: null };

/* ---------- tick store ---------- */
function loadTickStore(){
  if(tickMap) return;
  tickMap = new Map(); tickArr = [];
  try{
    const raw = JSON.parse(localStorage.getItem(USD_TICKS_KEY) || "[]");
    for(const r of raw){
      if(Array.isArray(r) && r[0] > 0 && r[1] > 0) tickMap.set(r[0], r[1]);
    }
  }catch(_){ }
  if(!tickMap.size){
    // one-time migration from the previous chart versions (they stored USD too)
    try{
      const old = []
        .concat(JSON.parse(localStorage.getItem(INTRADAY_HISTORY_KEY) || "[]"))
        .concat(loadHistory());
      for(const x of old){
        const ts = Number(x.ts), usd = Number(x.usd);
        if(ts > 0 && usd > 0) tickMap.set(Math.floor(ts / TICK_RES_MS) * TICK_RES_MS, usd);
      }
    }catch(_){ }
  }
  tickArr = [...tickMap.entries()].sort((a, b) => a[0] - b[0]);
}
function addTick(ts, usd, overwrite = true){
  loadTickStore();
  ts = Number(ts); usd = Number(usd);
  if(!(ts > 0) || !(usd > 0) || ts > Date.now() + 120000) return false;
  const b = Math.floor(ts / TICK_RES_MS) * TICK_RES_MS;
  if(tickMap.has(b)){
    if(!overwrite || tickMap.get(b) === usd) return false;
    tickMap.set(b, usd);
    let lo = 0, hi = tickArr.length - 1;
    while(lo <= hi){ const m = (lo + hi) >> 1; if(tickArr[m][0] === b){ tickArr[m][1] = usd; break; } tickArr[m][0] < b ? lo = m + 1 : hi = m - 1; }
  }else{
    tickMap.set(b, usd);
    const n = tickArr.length;
    if(!n || b > tickArr[n - 1][0]) tickArr.push([b, usd]);
    else{
      let lo = 0, hi = n;
      while(lo < hi){ const m = (lo + hi) >> 1; tickArr[m][0] < b ? lo = m + 1 : hi = m; }
      tickArr.splice(lo, 0, [b, usd]);
    }
  }
  tickDirty = true;
  if(Date.now() - tickLastSave > 30000) saveTickStore();
  return true;
}
function saveTickStore(force){
  if(!tickMap || (!tickDirty && !force)) return;
  const cutoff = Date.now() - TICK_KEEP_MS;
  while(tickArr.length && tickArr[0][0] < cutoff){ tickMap.delete(tickArr[0][0]); tickArr.shift(); }
  try{
    localStorage.setItem(USD_TICKS_KEY, JSON.stringify(tickArr));
  }catch(_){
    // quota: keep newer half and retry once
    try{
      const keep = tickArr.slice(Math.floor(tickArr.length / 2));
      tickMap = new Map(keep); tickArr = keep.slice();
      localStorage.setItem(USD_TICKS_KEY, JSON.stringify(tickArr));
    }catch(__){ }
  }
  tickDirty = false; tickLastSave = Date.now();
}

/* ---------- daily store ---------- */
function dayTimeSec(dateStr){
  const t = Date.parse(String(dateStr).slice(0, 10) + "T12:00:00Z");
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
function normalizeDaily(rows){
  const m = new Map();
  for(const r of rows){
    const time = Number(r.time), o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close);
    if(!(time > 0) || !(c > 0)) continue;
    const open = o > 0 ? o : c;
    m.set(time, { time, open, high: Math.max(h > 0 ? h : c, open, c), low: Math.min(l > 0 ? l : c, open, c), close: c });
  }
  return [...m.values()].sort((a, b) => a.time - b.time);
}
function closesToBars(list){ // [{time, close}] ascending
  const out = []; let prev = null;
  for(const x of list){
    const close = Number(x.close); if(!(close > 0)) continue;
    const open = prev ?? close;
    out.push({ time: x.time, open, high: Math.max(open, close), low: Math.min(open, close), close });
    prev = close;
  }
  return out;
}
function loadDailyStore(){
  if(dailyBars) return dailyBars;
  dailyBars = [];
  try{ dailyBars = normalizeDaily(JSON.parse(localStorage.getItem(USD_DAILY_KEY) || "[]")); }catch(_){ }
  if(!dailyBars.length){
    try{ // migrate from previous version (rows carried a usd close)
      const old = loadDailyHistory().map(x => ({ time: dayTimeSec(x.date || new Date(x.ts).toISOString()), close: Number(x.usd) }))
        .filter(x => x.time && x.close > 0).sort((a, b) => a.time - b.time);
      dailyBars = normalizeDaily(closesToBars(old));
    }catch(_){ }
  }
  return dailyBars;
}
function saveDailyStore(rows){
  dailyBars = normalizeDaily(rows).slice(-400);
  try{ localStorage.setItem(USD_DAILY_KEY, JSON.stringify(dailyBars)); }catch(_){ }
}
function mergeDaily(newRows){
  saveDailyStore(loadDailyStore().concat(newRows));
}

/* ---------- remote data (XAU/USD) ---------- */
async function fetchIntradayGold(){
  loadTickStore();
  if(tickMap.size && Date.now() - lastIntradayFetch < 180000) return true; // throttle: 3 min
  lastIntradayFetch = Date.now();
  try{
    const data = await fetchJSON(`https://xaus.com/api/v1/intraday?symbol=xau&hours=24&fresh=${Date.now()}`);
    const raw = Array.isArray(data?.points) ? data.points : [];
    if(!raw.length) return false;
    let added = 0;
    for(const p of raw){
      const ts = typeof p.t === "number" ? (p.t < 1e12 ? p.t * 1000 : p.t) : Date.parse(p.t);
      if(addTick(ts, Number(p.p), false)) added++;
    }
    saveTickStore(true);
    if(added) renderChart("data");
    return true;
  }catch(_){ lastIntradayFetch = Date.now() - 120000; return false; }
}
async function fetchHistoricalGold(){
  loadDailyStore();
  if(dailyBars.length && Date.now() - lastHistoryFetch < 300000) return true; // throttle: 5 min
  lastHistoryFetch = Date.now();
  const now = new Date(), from = new Date(now.getTime() - 400 * 86400000);
  try{
    const data = await fetchJSON(`https://xaus.com/api/v1/history?fresh=${Date.now()}`);
    const points = Array.isArray(data?.points) ? data.points : [];
    if(!points.length) throw new Error("no daily history");
    const list = points.map(p => ({ time: dayTimeSec(p.d), close: Number(p.c) }))
      .filter(x => x.time && x.close > 0).sort((a, b) => a.time - b.time);
    if(!list.length) throw new Error("bad daily history");
    mergeDaily(closesToBars(list));
    renderChart("data");
    return true;
  }catch(_){
    try{
      const data = await fetchJSON(`https://api.goldprice.dev/v1/bars?symbol=XAU-USD-SPOT&interval=1d&from=${ymd(from)}&to=${ymd(now)}&limit=400`);
      const bars = Array.isArray(data?.bars) ? data.bars : [];
      const rows = bars.map(b => ({ time: dayTimeSec(b.bar_start), open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close) }))
        .filter(x => x.time && x.close > 0);
      if(rows.length){ mergeDaily(rows); renderChart("data"); return true; }
    }catch(__){ }
    lastHistoryFetch = Date.now() - 240000;
    return false;
  }
}

/* ---------- live tick from the polling loop ---------- */
function recordLiveTick(){
  let usd = Number(state.spotUsdOz);
  if(!(usd > 0)){
    const fx = chartFx();
    if(fx && Number(state.priceThbGram) > 0) usd = Number(state.priceThbGram) * OZ_TO_GRAM / fx / (99.99 / 100);
  }
  if(!(usd > 0)) return;
  const u = state.updatedAt;
  let ts = typeof u === "number" ? (u < 1e12 ? u * 1000 : u) : Date.parse(u);
  if(!Number.isFinite(ts)) ts = Date.now();
  addTick(Math.min(ts, Date.now()), usd, true);
}
function chartFx(){
  if(Number.isFinite(Number(state.usdThb)) && Number(state.usdThb) > 0) return Number(state.usdThb);
  if(Number(state.priceThbOz) > 0 && Number(state.spotUsdOz) > 0) return Number(state.priceThbOz) / Number(state.spotUsdOz);
  return null;
}

/* ---------- bars ---------- */
function aggregateTicks(arr, intervalMs){
  const out = []; let cur = null;
  for(const [ms, v] of arr){
    const t = Math.floor(Math.floor(ms / intervalMs) * intervalMs / 1000);
    if(!cur || cur.time !== t){
      if(cur) out.push(cur);
      cur = { time: t, open: v, high: v, low: v, close: v };
    }else{
      if(v > cur.high) cur.high = v;
      if(v < cur.low) cur.low = v;
      cur.close = v;
    }
  }
  if(cur) out.push(cur);
  return out;
}
function buildDailyBars(){
  const daily = loadDailyStore().slice();
  const byTime = new Map(daily.map(b => [b.time, b]));
  // today's/recent days from ticks (UTC date, 12:00 UTC label like the daily store)
  const days = new Map();
  for(const [ms, v] of tickArr){
    const t = Math.floor(ms / 86400000) * 86400 + 43200;
    const d = days.get(t);
    if(!d) days.set(t, { time: t, open: v, high: v, low: v, close: v });
    else{ if(v > d.high) d.high = v; if(v < d.low) d.low = v; d.close = v; }
  }
  const merged = [...byTime.values()];
  for(const d of days.values()){
    const ex = byTime.get(d.time);
    if(ex){ ex.high = Math.max(ex.high, d.high); ex.low = Math.min(ex.low, d.low); ex.close = d.close; }
    else merged.push(d);
  }
  merged.sort((a, b) => a.time - b.time);
  // chain opens so candles are continuous
  for(let i = 1; i < merged.length; i++){
    const b = merged[i], prev = merged[i - 1].close;
    if(!byTime.has(b.time)){
      b.open = prev; b.high = Math.max(b.high, prev); b.low = Math.min(b.low, prev);
    }
  }
  return merged;
}
function buildBars(interval){
  loadTickStore();
  chartInfo.firstIntradaySec = null;
  if(interval === "1D") return buildDailyBars();
  const ms = CHART_INTERVALS[interval] || CHART_INTERVALS["5m"];
  const intr = aggregateTicks(tickArr, ms);
  const daily = loadDailyStore();
  if(!intr.length) return daily.slice();
  chartInfo.firstIntradaySec = intr[0].time;
  const firstDay = Math.floor(intr[0].time / 86400) * 86400;
  return daily.filter(d => d.time < firstDay).concat(intr);
}
function windowStartSec(){ return Date.now() / 1000 - (RANGE_DAYS[state.range] || 1) * 86400; }
function firstIndexInWindow(bars){
  const from = windowStartSec();
  let idx = bars.findIndex(b => b.time >= from);
  if(idx < 0) idx = Math.max(0, bars.length - 60);
  return Math.min(idx, Math.max(0, bars.length - 8));
}
const toPoint = b => chartMode === "candle"
  ? { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }
  : { time: b.time, value: b.close };

/* ---------- formatting ---------- */
function formatChartPrice(v, dec = 2){ return `฿${Number(v).toLocaleString("th-TH", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`; }
function formatUsdPrice(v, dec = 2){ return `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`; }
function chartTime(ts){ return Math.floor(Number(ts) / 1000); }
function tickMarkFormatter(time, type){
  const d = new Date(Number(time) * 1000);
  const f = o => new Intl.DateTimeFormat("th-TH", Object.assign({ timeZone: PURCHASE_TIMEZONE }, o)).format(d);
  switch(type){
    case 0: return f({ year: "numeric" });
    case 1: return f({ month: "short" });
    case 2: return f({ day: "numeric", month: "short" });
    default: return f({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
}

/* ---------- lots (purchase markers) ---------- */
function getLotsForChart(){
  const now = Date.now();
  const days = RANGE_DAYS[state.range] || 1;
  const start = now - days * 86400000;
  const end = now + 86400000;
  return loadLots().filter(l => {
    const ts = parseLotTimestamp(l.date, l.time);
    if(!Number.isFinite(ts)) return false;
    const markerStart = state.range === "1D" ? start - 86400000 : start;
    return ts >= markerStart && ts <= end;
  });
}
function lotBuyUsdOz(lot){
  const grams = Number(lot.grams) || unitToGrams(Number(lot.quantity) || 0, lot.unit);
  if(!(grams > 0)) return null;
  const buyGram = Number(lot.buyPriceThbGram) > 0 ? Number(lot.buyPriceThbGram) : (Number(lot.costThb) > 0 ? Number(lot.costThb) / grams : 0);
  if(!(buyGram > 0)) return null;
  const fx = chartFx();
  const usd = fx && fx > 0 ? buyGram * OZ_TO_GRAM / fx : 0;
  return usd > 0 ? { grams, buyGram, usd } : null;
}

/* ---------- chart creation ---------- */
function setChartEmpty(text){
  const stage = $("chartStageOz"); if(!stage) return;
  let el = stage.querySelector(".chart-empty-msg");
  if(!text){ if(el) el.remove(); return; }
  if(!el){ el = document.createElement("div"); el.className = "chart-empty-msg"; stage.appendChild(el); }
  el.textContent = text;
}
function scheduleChartRetry(){
  if(chartRetryTimer) return;
  chartRetryTimer = setTimeout(() => { chartRetryTimer = null; renderChart(); }, 800);
}
function ensureChart(){
  if(chart) return true;
  const el = $("goldChartOz"); if(!el) return false;
  if(!window.LightweightCharts){
    const hint = $("chartHint"); if(hint) hint.textContent = "กำลังโหลดระบบกราฟ…";
    setChartEmpty("กำลังโหลดระบบกราฟ…");
    scheduleChartRetry();
    return false;
  }
  try{
    chart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { type: "solid", color: "#0b0d0e" }, textColor: "#8d8d8d", fontSize: 11, fontFamily: "Prompt, system-ui, sans-serif" },
      grid: { vertLines: { color: "rgba(212,175,55,.05)" }, horzLines: { color: "rgba(212,175,55,.09)" } },
      rightPriceScale: { borderColor: "#292b2b", scaleMargins: { top: .12, bottom: .1 }, minimumWidth: 66 },
      timeScale: { borderColor: "#292b2b", timeVisible: true, secondsVisible: false, rightOffset: 3, barSpacing: 8, minBarSpacing: .5, maxBarSpacing: 26, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true, tickMarkFormatter },
      localization: { timeFormatter: formatChartTime, priceFormatter: p => Number(p).toFixed(2) },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: "#d4af37", width: 1, style: 2, labelBackgroundColor: "#8f7218" }, horzLine: { color: "#d4af37", width: 1, style: 2, labelBackgroundColor: "#8f7218" } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      kineticScroll: { mouse: false, touch: true }
    });
    const pf = { type: "price", precision: 2, minMove: .01 };
    areaSeries = chart.addAreaSeries({ topColor: "rgba(212,175,55,.30)", bottomColor: "rgba(212,175,55,.02)", lineColor: "#e6c34a", lineWidth: 2, priceLineVisible: true, lastValueVisible: true, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, priceFormat: pf });
    candleSeries = chart.addCandlestickSeries({ upColor: "#62db8a", downColor: "#ff5d68", borderUpColor: "#62db8a", borderDownColor: "#ff5d68", wickUpColor: "#62db8a", wickDownColor: "#ff5d68", priceFormat: pf });

    // keep purchase prices inside the visible price range
    const autoscale = original => {
      const info = original();
      if(!info?.priceRange) return info;
      const prices = getLotsForChart().map(lotBuyUsdOz).filter(Boolean).map(x => x.usd);
      if(!prices.length) return info;
      const min = Math.min(info.priceRange.minValue, ...prices), max = Math.max(info.priceRange.maxValue, ...prices);
      if(!(Number.isFinite(min) && Number.isFinite(max))) return info;
      const pad = Math.max(max - min, 1e-6) * 0.03;
      return { ...info, priceRange: { minValue: min - pad, maxValue: max + pad } };
    };
    areaSeries.applyOptions({ autoscaleInfoProvider: autoscale });
    candleSeries.applyOptions({ autoscaleInfoProvider: autoscale });
    applyChartModeVisibility();

    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleOverlay);
    chart.subscribeCrosshairMove(param => {
      scheduleOverlay();
      const tip = $("chartTooltipOz"); if(!tip) return;
      const row = param?.seriesData?.get(activeSeries());
      const value = row?.value ?? row?.close;
      if(!param?.time || !Number.isFinite(Number(value))){ tip.textContent = lastBarText(); return; }
      const dt = new Intl.DateTimeFormat("th-TH", { timeZone: PURCHASE_TIMEZONE, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Number(param.time) * 1000));
      const extra = row?.close != null && row?.open != null ? ` · O ${row.open.toFixed(2)} H ${row.high.toFixed(2)} L ${row.low.toFixed(2)} C ${row.close.toFixed(2)}` : "";
      tip.textContent = `${dt} · ${formatUsdPrice(Number(value))}/troy oz${extra}`;
    });
    if(window.ResizeObserver){
      new ResizeObserver(() => scheduleOverlay()).observe($("chartStageOz"));
    }
    setChartEmpty("");
    return true;
  }catch(e){
    console.warn("chart init failed:", e);
    chart = null; areaSeries = null; candleSeries = null;
    const hint = $("chartHint"); if(hint) hint.textContent = "สร้างกราฟไม่สำเร็จ · ลองรีเฟรชหน้า";
    return false;
  }
}
function activeSeries(){ return chartMode === "candle" ? candleSeries : areaSeries; }
function applyChartModeVisibility(){
  if(!areaSeries || !candleSeries) return;
  areaSeries.applyOptions({ visible: chartMode !== "candle" });
  candleSeries.applyOptions({ visible: chartMode === "candle" });
  const btn = $("chartCandleBtn");
  if(btn){ btn.classList.toggle("active", chartMode === "candle"); btn.textContent = chartMode === "candle" ? "〽️ กราฟเส้น" : "🕯️ แท่งเทียน"; }
}
function lastBarText(){
  const b = chartBars[chartBars.length - 1];
  return b ? `ล่าสุด · ${formatUsdPrice(b.close)}/troy oz` : "";
}

/* ---------- rendering ---------- */
function canIncremental(oldBars, newBars){
  const n = oldBars.length, m = newBars.length;
  if(!n || m < n || m - n > 2) return false;
  if(oldBars[0].time !== newBars[0].time) return false;
  if(n >= 2 && oldBars[n - 2].time !== newBars[n - 2].time) return false;
  return oldBars[n - 1].time === newBars[n - 1].time;
}
function setActiveData(bars){
  const a = activeSeries(), other = chartMode === "candle" ? areaSeries : candleSeries;
  a.setData(bars.map(toPoint));
  other.setData([]);
}
function renderChart(reason){
  try{ recordLiveTick(); }catch(_){ }
  if(!ensureChart()) { updateChartStats([]); return; }
  let bars;
  try{ bars = buildBars(chartInterval); }catch(e){ console.warn("buildBars", e); return; }
  const key = `${state.range}|${chartInterval}|${chartMode}`;
  const needFull = reason === true || reason === "reset" || key !== chartKey || !chartBars.length || !canIncremental(chartBars, bars);

  if(!bars.length){
    areaSeries.setData([]); candleSeries.setData([]);
    chartBars = []; chartKey = key;
    setChartEmpty("กำลังรวบรวมข้อมูลราคา…");
    updateChartStats([]); updateChartHint([]); drawPurchaseOverlay();
    return;
  }
  setChartEmpty("");

  if(!needFull){
    try{
      for(let i = chartBars.length - 1; i < bars.length; i++) activeSeries().update(toPoint(bars[i]));
      chartBars = bars;
    }catch(_){ setActiveData(bars); chartBars = bars; }
  }else{
    const ts = chart.timeScale();
    const sameKey = key === chartKey && chartBars.length && reason !== "reset";
    let keep = null;
    if(sameKey){ // data refreshed in background: keep the user's position
      const lr = ts.getVisibleLogicalRange();
      if(lr){
        const aIdx = Math.max(0, Math.min(chartBars.length - 1, Math.round(lr.from)));
        keep = { lr, aTime: chartBars[aIdx].time, aIdx, atEnd: lr.to >= chartBars.length - 2, oldLen: chartBars.length };
      }
    }
    const modeLr = reason === "mode" ? ts.getVisibleLogicalRange() : null;
    setActiveData(bars);
    chartBars = bars; chartKey = key;
    if(modeLr){
      try{ ts.setVisibleLogicalRange(modeLr); }catch(_){ applyDefaultView(); }
    }else if(keep){
      const span = keep.lr.to - keep.lr.from;
      let to, from;
      if(keep.atEnd){ to = bars.length - 1 + (keep.lr.to - (keep.oldLen - 1)); from = to - span; }
      else{
        let nIdx = bars.findIndex(b => b.time >= keep.aTime); if(nIdx < 0) nIdx = 0;
        from = nIdx + (keep.lr.from - keep.aIdx); to = from + span;
      }
      try{ ts.setVisibleLogicalRange({ from, to }); }catch(_){ applyDefaultView(); }
    }else applyDefaultView();
  }
  updateChartStats(chartBars);
  updateChartHint(chartBars);
  scheduleOverlay();
}
function applyDefaultView(){
  if(!chart || !chartBars.length) return;
  const idx = firstIndexInWindow(chartBars);
  try{
    chart.priceScale("right").applyOptions({ autoScale: true });
    chart.timeScale().setVisibleLogicalRange({ from: idx - 0.5, to: chartBars.length - 1 + 3 });
  }catch(_){ try{ chart.timeScale().fitContent(); }catch(__){ } }
  scheduleOverlay();
}
function windowBars(bars){
  if(!bars.length) return [];
  return bars.slice(firstIndexInWindow(bars));
}
function updateChartStats(bars){
  const set = (id, t) => { const e = $(id); if(e) e.textContent = t; };
  const win = windowBars(bars);
  if(!win.length){
    set("chartCurrentOz", "ปัจจุบัน: -"); set("chartHighOz", "สูงสุด: -"); set("chartLowOz", "ต่ำสุด: -"); set("chartChangeOz", "เปลี่ยนแปลง: -");
    return;
  }
  const cur = bars[bars.length - 1].close, first = win[0].open;
  const high = Math.max(...win.map(b => b.high)), low = Math.min(...win.map(b => b.low));
  const ch = first ? ((cur - first) / first) * 100 : 0;
  set("chartCurrentOz", `ปัจจุบัน: ${formatUsdPrice(cur)}`);
  set("chartHighOz", `สูงสุด: ${formatUsdPrice(high)}`);
  set("chartLowOz", `ต่ำสุด: ${formatUsdPrice(low)}`);
  set("chartChangeOz", `เปลี่ยนแปลง: ${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`);
  const el = $("chartChangeOz"); if(el){ el.style.color = ch >= 0 ? "#62db8a" : "#ff5d68"; }
}
function updateChartHint(bars){
  const hint = $("chartHint"); if(!hint) return;
  const win = windowBars(bars);
  let t = `${state.range} · แท่ง ${chartInterval} · ${win.length} แท่ง · ${chartMode === "candle" ? "แท่งเทียน" : "กราฟเส้น"} · ลาก/บีบนิ้วเพื่อเลื่อนและซูม`;
  if(chartInterval !== "1D" && !chartInfo.firstIntradaySec && bars.length){
    t += " · ยังไม่มีข้อมูล Intraday แสดงเป็นแท่งรายวันชั่วคราว";
  }else if(chartInterval !== "1D" && chartInfo.firstIntradaySec && chartInfo.firstIntradaySec > windowStartSec() + 3600){
    t += " · ช่วงก่อนหน้าข้อมูล Intraday แสดงเป็นแท่งรายวัน";
  }
  hint.textContent = t;
}

/* ---------- purchase overlay ---------- */
function svgEl(tag, attrs){ const e = document.createElementNS("http://www.w3.org/2000/svg", tag); for(const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; }
function scheduleOverlay(){
  if(overlayRaf) return;
  overlayRaf = requestAnimationFrame(() => { overlayRaf = 0; try{ drawPurchaseOverlay(); }catch(_){ } });
}
function drawPurchaseOverlays(){ scheduleOverlay(); }
function barTimeFor(ts){ // snap to the bar that contains ts
  if(!chartBars.length) return null;
  if(ts < chartBars[0].time) return null;
  let lo = 0, hi = chartBars.length - 1;
  while(lo < hi){ const m = (lo + hi + 1) >> 1; chartBars[m].time <= ts ? lo = m : hi = m - 1; }
  return chartBars[lo].time;
}
function drawPurchaseOverlay(){
  const svg = $("chartOverlayOz"); if(!svg) return;
  const host = $("chartStageOz");
  const w = host?.clientWidth || 0, h = host?.clientHeight || 0;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`); svg.innerHTML = "";
  if(!chart || !chartBars.length || !w || !h) return;
  const series = activeSeries();
  const current = Number(state.priceThbGram) || 0;
  if(!(current > 0)) return;
  const priceW = 66; // right price axis
  for(const lot of getLotsForChart()){
    const info = lotBuyUsdOz(lot); if(!info) continue;
    const ts = chartTime(parseLotTimestamp(lot.date, lot.time));
    const bt = barTimeFor(ts); if(bt == null) continue;
    const x = chart.timeScale().timeToCoordinate(bt);
    const y = series.priceToCoordinate(info.usd);
    if(x == null || y == null || x < 0 || x > w - priceW) continue;
    const purity = Number(lot.goldType || 99.99) / 99.99;
    const pl = (current * purity - info.buyGram) * info.grams;
    const color = pl >= 0 ? "#62db8a" : "#ff5d68";
    const v = svgEl("line", { x1: x, y1: 0, x2: x, y2: h, stroke: color, class: "purchase-vline" });
    const hl = svgEl("line", { x1: 0, y1: y, x2: w - priceW, y2: y, stroke: color, class: "purchase-hline" });
    const dot = svgEl("circle", { cx: x, cy: y, r: 6, fill: color, class: "purchase-dot" });
    const lx = Math.min(Math.max(x + 8, 8), Math.max(8, w - priceW - 140));
    const label = svgEl("text", { x: lx, y: Math.max(16, y - 9), fill: color, class: "purchase-label" }); label.textContent = `${pl >= 0 ? "+" : ""}${money(pl)}`;
    const price = svgEl("text", { x: lx, y: Math.min(h - 22, Math.max(30, y + 15)), fill: "#d4af37", class: "purchase-sub" }); price.textContent = `ซื้อ ${formatUsdPrice(info.usd)}/oz`;
    const time = svgEl("text", { x: Math.min(Math.max(x + 5, 5), Math.max(5, w - priceW - 125)), y: h - 8, fill: "#bdbdbd", class: "purchase-sub" }); time.textContent = `${lot.date} ${lot.time || ""} · ${num(info.grams, 4)}g`;
    svg.append(v, hl, dot, label, price, time);
  }
}

/* ---------- controls ---------- */
function syncChartControls(){
  document.querySelectorAll(".chart-tab[data-range]").forEach(x => x.classList.toggle("active", x.dataset.range === state.range));
  document.querySelectorAll(".chart-interval").forEach(x => x.classList.toggle("active", x.dataset.interval === chartInterval));
}
function barsInWindow(range, interval){ return (RANGE_DAYS[range] * 86400000) / CHART_INTERVALS[interval]; }
function setChartRange(range){
  if(!RANGE_DAYS[range]) return;
  state.range = range;
  const order = ["5m", "15m", "30m", "1H", "1D"];
  let n = barsInWindow(range, chartInterval);
  if(n > TARGET_MAX_BARS || n < 12){
    // choose the finest interval that keeps the window readable
    chartInterval = order.find(i => barsInWindow(range, i) <= TARGET_MAX_BARS) || "1D";
  }
  syncChartControls();
  chartKey = "";
  renderChart("reset");
  if(range !== "1D"){ fetchHistoricalGold(); }
}
function setChartInterval(interval){
  if(!CHART_INTERVALS[interval]) return;
  chartInterval = interval;
  if(interval === "1D" && state.range === "1D") state.range = "30D";
  syncChartControls();
  chartKey = "";
  renderChart("reset");
}
function setChartMode(mode){
  chartMode = mode === "candle" ? "candle" : "line";
  applyChartModeVisibility();
  renderChart("mode");
}
function resetChartZoom(){
  if(!chart) return;
  applyDefaultView();
}
function fitChart(){
  if(!chart) return;
  try{ chart.priceScale("right").applyOptions({ autoScale: true }); chart.timeScale().fitContent(); }catch(_){ }
  scheduleOverlay();
}
function toggleChartFullscreen(){
  const wrap = $("chartStageOz")?.closest(".chart-wrap"); if(!wrap) return;
  const on = wrap.classList.toggle("chart-fullscreen");
  document.documentElement.classList.toggle("chart-fs-lock", on);
  const btn = $("chartFullscreenBtn"); if(btn) btn.textContent = on ? "✕ ออกจากเต็มจอ" : "⛶ เต็มจอ";
  // autoSize follows the container; just redraw overlay once layout settled
  setTimeout(scheduleOverlay, 120); setTimeout(scheduleOverlay, 400);
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
    buyPriceThbGram:Number($("buyPrice")?.value)||null,
    buyFx:Number($("buyFx")?.value)||null,
    entryBahtPrice:Number($("entryBaht")?.value)||null,
    note:$("note").value.trim(),
    createdAt:new Date().toISOString()
  });
  saveLots(lots);
  selectedLotNumber=lots.length;
  $("lotForm").reset();
  $("buyDate").value=isoDate(new Date());
  // Normal use: Thai 96.5% gold measured in baht-weight.
  $("goldType").value="96.5";
  $("unit").value="baht";
  updateLotPreview();
  renderPortfolio();renderLots();renderChart();
  alert("บันทึกรอบซื้อเรียบร้อยแล้ว");
}

function deleteLot(id){
  const lots=loadLots();
  const target=lots.find(x=>x.id===id);
  if(!target)return;
  if(!confirm(`ลบรอบซื้อวันที่ ${target.date} ใช่หรือไม่?`))return;
  const nextLots=lots.filter(x=>x.id!==id);
  saveLots(nextLots);
  selectedLotNumber=Math.min(selectedLotNumber || nextLots.length, nextLots.length || 1);
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
    <small>${
      getEffectiveSellPrice().mode === "gold2go" && getEffectiveSellPrice().exact
        ? `ใช้ราคา GOLD2go "รับซื้อ" ที่บันทึกไว้ · ทอง 96.5% ใช้ราคานี้โดยตรง`
        : getEffectiveSellPrice().gold2goMissing
          ? "ยังไม่มีราคา GOLD2go ที่บันทึกไว้ จึงใช้ XAU/THB เป็นค่าประมาณชั่วคราว"
          : "ใช้ราคาตลาด XAU/THB และคำนึงถึงเปอร์เซ็นต์ทองของแต่ละ Lot"
    }</small>`;
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


// Called by auth.js when Cloud data is loaded after login on an already-open gold page.
window.__kfpRefreshGoldFromCloud = function(){
  try {
    const settings=loadSettings();
    state.gold2go={
      receivePrice:Number(settings.gold2goReceiveBaht || settings.gold2goBuyBaht)>0
        ? Number(settings.gold2goReceiveBaht || settings.gold2goBuyBaht) : null,
      sellPrice:sanitizeGold2goSell(settings.gold2goReceiveBaht||settings.gold2goBuyBaht, settings.gold2goSellBaht),
      updatedAt:settings.gold2goUpdatedAt || null,
      source:settings.gold2goPriceSource || null
    };
    if($('valuationSource')) $('valuationSource').value=settings.valuationSource==='market' ? 'market' : 'gold2go';
    if($('gold2goBuyBaht')) $('gold2goBuyBaht').value=settings.gold2goBuyBaht||'';
    updateValuationSourceUI();
    updateGold2goQuoteUI();
    renderPortfolio();
    renderLots();
    renderChart();
  } catch(e) {
    console.warn('KFP gold cloud UI refresh:', e);
  }
};

/* =========================================================================
   📰 ข่าวทอง & เศรษฐกิจ
   - แหล่งข่าว: Google News RSS (ภาษาไทย) ผ่าน rss2json (CORS เปิด, ไม่ต้องใช้ key)
     ถ้าล้มเหลวจะลองดึง RSS ผ่าน allorigins แล้วแปลงเอง
   - ข่าวเก่ากว่า 7 วันจะถูกตัดทิ้งทุกครั้งที่แสดงผล (รวมข่าวที่แคชไว้)
   - ถ้าไม่มีข่าวเลย การ์ดนี้จะซ่อนตัวเอง
   ========================================================================= */
const NEWS_CACHE_KEY="kfp_gold_news_v1";
const NEWS_MAX_AGE_MS=7*86400000;
const NEWS_REFRESH_MS=15*60*1000;
const NEWS_PAGE=8;
const NEWS_FEEDS=[
  {topic:"gold",q:"ราคาทองคำ"},
  {topic:"gold",q:"ทองคำ ตลาดโลก"},
  {topic:"fx",q:"ค่าเงินบาท ดอลลาร์"},
  {topic:"fx",q:"ค่าเงินวอน"},
  {topic:"eco",q:"เศรษฐกิจ เฟด ดอกเบี้ย เงินเฟ้อ"}
];
const NEWS_TOPICS={all:"ทั้งหมด",gold:"🥇 ทอง",fx:"💱 ค่าเงิน",eco:"📊 เศรษฐกิจ"};
let newsItems=[], newsTopic="all", newsShown=NEWS_PAGE, newsFetchedAt=0, newsLoading=false, newsTimer=null;

function newsKey(t){return String(t||"").toLowerCase().replace(/\s+/g,"").replace(/[^\p{L}\p{N}]/gu,"").slice(0,60);}
function newsParseDate(v){
  if(!v) return NaN;
  let str=String(v).trim();
  if(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(str)) str=str.replace(" ","T")+"Z"; // rss2json = UTC
  return Date.parse(str);
}
function newsNormalize(raw,topic){
  const link=String(raw.link||"").trim();
  if(!/^https?:\/\//i.test(link)) return null;
  let title=String(raw.title||"").replace(/\s+/g," ").trim();
  let source=String(raw.source||raw.author||"").trim();
  const i=title.lastIndexOf(" - ");
  if(i>10){ if(!source) source=title.slice(i+3).trim(); title=title.slice(0,i).trim(); }
  const ts=newsParseDate(raw.pubDate||raw.published||raw.date);
  if(!title || !Number.isFinite(ts)) return null;
  return {title,source,link,ts,topic};
}
async function newsFetchText(url){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),9000);
  try{
    const r=await fetch(url,{cache:"no-store",signal:c.signal});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
async function newsFetchFeed(feed){
  const rssUrl=`https://news.google.com/rss/search?q=${encodeURIComponent(feed.q+" when:7d")}&hl=th&gl=TH&ceid=TH:th`;
  try{
    const data=await fetchJSON(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`);
    if(data?.status!=="ok" || !Array.isArray(data.items)) throw new Error("rss2json bad response");
    return data.items.map(x=>newsNormalize(x,feed.topic)).filter(Boolean);
  }catch(_){
    let xml;
    try{ xml=await newsFetchText(`https://api.allorigins.win/raw?url=${encodeURIComponent(rssUrl)}`); }
    catch(__){ xml=await newsFetchText(`https://corsproxy.io/?url=${encodeURIComponent(rssUrl)}`); }
    const doc=new DOMParser().parseFromString(xml,"text/xml");
    return [...doc.querySelectorAll("item")].map(it=>newsNormalize({
      title:it.querySelector("title")?.textContent,
      link:it.querySelector("link")?.textContent,
      pubDate:it.querySelector("pubDate")?.textContent,
      source:it.querySelector("source")?.textContent
    },feed.topic)).filter(Boolean);
  }
}
function newsFresh(list){
  const now=Date.now(), seen=new Set(), out=[];
  for(const it of list.sort((a,b)=>b.ts-a.ts)){
    if(now-it.ts>NEWS_MAX_AGE_MS) continue;     // เกิน 7 วัน -> ตัดทิ้ง
    if(it.ts-now>3600_000) continue;            // เวลาอนาคตผิดปกติ
    const k=newsKey(it.title); if(!k||seen.has(k)) continue;
    seen.add(k); out.push(it);
  }
  return out.slice(0,80);
}
function newsLoadCache(){
  try{
    const c=JSON.parse(localStorage.getItem(NEWS_CACHE_KEY)||"null");
    if(c&&Array.isArray(c.items)){ newsFetchedAt=Number(c.fetchedAt)||0; return c.items; }
  }catch(_){}
  return [];
}
function newsSaveCache(){
  try{ localStorage.setItem(NEWS_CACHE_KEY,JSON.stringify({fetchedAt:newsFetchedAt,items:newsItems})); }catch(_){}
}
function newsAgo(ts){
  const m=Math.max(0,Math.round((Date.now()-ts)/60000));
  if(m<1) return "เมื่อสักครู่";
  if(m<60) return `${m} นาทีที่แล้ว`;
  const h=Math.round(m/60);
  if(h<24) return `${h} ชม.ที่แล้ว`;
  return `${Math.round(h/24)} วันที่แล้ว`;
}
async function loadNews(force){
  if(newsLoading) return;
  if(!force && newsItems.length && Date.now()-newsFetchedAt<NEWS_REFRESH_MS){ renderNews(); return; }
  newsLoading=true;
  const btn=$("newsRefreshBtn"); if(btn){ btn.disabled=true; btn.textContent="⏳"; }
  try{
    const results=await Promise.allSettled(NEWS_FEEDS.map(newsFetchFeed));
    const got=results.filter(r=>r.status==="fulfilled").flatMap(r=>r.value);
    const okFeeds=results.filter(r=>r.status==="fulfilled").length;
    if(okFeeds){
      newsItems=newsFresh(got.concat(newsItems));
      newsFetchedAt=Date.now();
      newsSaveCache();
    }
  }catch(_){}
  newsLoading=false;
  if(btn){ btn.disabled=false; btn.textContent="🔄"; }
  renderNews();
}
function renderNews(){
  const card=$("newsCard"); if(!card) return;
  newsItems=newsFresh(newsItems);              // ตัดข่าวที่เกิน 7 วันทุกครั้งที่แสดง
  if(!newsItems.length){
    // ไม่ซ่อนการ์ดเงียบๆ อีกต่อไป: ถ้ายังโหลดอยู่ให้บอกสถานะ ถ้าล้มเหลวให้มีปุ่มลองใหม่
    card.hidden=false;
    const meta0=$("newsMeta");
    if(meta0) meta0.textContent=newsLoading?"กำลังโหลดข่าว…":"ดึงข่าวไม่สำเร็จ · กด 🔄 เพื่อลองใหม่";
    const t0=$("newsTabs"); if(t0) t0.innerHTML="";
    const l0=$("newsList"); if(l0) l0.innerHTML="";
    const m0=$("newsMoreBtn"); if(m0) m0.hidden=true;
    return;
  }
  card.hidden=false;
  card.hidden=false;
  const tabs=$("newsTabs");
  if(tabs){
    tabs.innerHTML="";
    for(const [k,label] of Object.entries(NEWS_TOPICS)){
      const b=document.createElement("button");
      b.type="button"; b.className="news-tab"+(k===newsTopic?" active":"");
      b.textContent=label; b.dataset.topic=k;
      tabs.appendChild(b);
    }
  }
  const list=newsItems.filter(x=>newsTopic==="all"||x.topic===newsTopic);
  const box=$("newsList"); box.innerHTML="";
  list.slice(0,newsShown).forEach(it=>{
    const a=document.createElement("a");
    a.className="news-item"; a.href=it.link; a.target="_blank"; a.rel="noopener noreferrer";
    const t=document.createElement("div"); t.className="news-title"; t.textContent=it.title;
    const m=document.createElement("div"); m.className="news-meta";
    const tag=document.createElement("span"); tag.className="news-tag "+it.topic; tag.textContent=NEWS_TOPICS[it.topic]||"";
    const src=document.createElement("span"); src.textContent=[it.source,newsAgo(it.ts)].filter(Boolean).join(" · ");
    m.append(tag,src); a.append(t,m); box.appendChild(a);
  });
  if(!list.length){ const e=document.createElement("div"); e.className="empty-state"; e.textContent="ยังไม่มีข่าวในหมวดนี้"; box.appendChild(e); }
  const more=$("newsMoreBtn"); if(more) more.hidden=list.length<=newsShown;
  const meta=$("newsMeta");
  if(meta) meta.textContent=`ข่าวย้อนหลังไม่เกิน 7 วัน · อัปเดต ${newsFetchedAt?new Date(newsFetchedAt).toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit",hour12:false}):"-"} น. · Google News`;
}
function initNews(){
  const card=$("newsCard"); if(!card) return;
  newsItems=newsFresh(newsLoadCache());
  renderNews();                                // แสดงข่าวที่แคชไว้ทันที (ถ้ามี)
  $("newsTabs").addEventListener("click",e=>{
    const b=e.target.closest(".news-tab"); if(!b) return;
    newsTopic=b.dataset.topic; newsShown=NEWS_PAGE; renderNews();
  });
  $("newsMoreBtn").addEventListener("click",()=>{ newsShown+=NEWS_PAGE; renderNews(); });
  $("newsRefreshBtn").addEventListener("click",()=>loadNews(true));
  loadNews(false);
  newsTimer=setInterval(()=>{ if(!document.hidden) loadNews(false); },NEWS_REFRESH_MS);
  document.addEventListener("visibilitychange",()=>{ if(!document.hidden) loadNews(false); });
}

/* ---------- 🧮 เครื่องคำนวณตั้งราคาซื้อ: USD/troy oz -> ทองแท่ง 96.5% (บาท/บาททอง) ---------- */
function calcThaiBarFromOz(){
  const out=$("buyCalcResult"), input=$("buyCalcOz");
  if(!out || !input) return;
  const oz=Number(input.value);
  if(!(oz>0)){
    out.className="buy-calc-result warn";
    out.textContent="กรุณากรอกราคาทองต่อ troy oz (USD) ให้ถูกต้อง";
    return;
  }
  const fx=Number(state.usdThb);
  if(!(fx>0)){
    out.className="buy-calc-result warn";
    out.textContent="ยังไม่มีอัตรา USD/THB · รอระบบโหลดราคาสักครู่แล้วกดคำนวณอีกครั้ง";
    return;
  }
  // 96.5% bar: USD/oz × USDTHB ÷ grams per troy oz × grams per baht-weight × 0.965
  const price=oz*fx/OZ_TO_GRAM*BAHT_GOLD_GRAM*0.965;
  out.className="buy-calc-result ok";
  out.innerHTML=`
    <div class="buy-calc-label">ทองแท่ง 96.5% ≈</div>
    <div class="buy-calc-price">${money(price)}<small> / บาททอง</small></div>
    <div class="buy-calc-note">จาก ${formatUsdPrice(oz)}/oz × USD/THB ${num(fx,4)} · ค่าตามสูตรทฤษฎี ยังไม่รวมส่วนต่าง/พรีเมียมของร้านหรือสมาคมฯ</div>`;
}

function setup(){
  $("buyDate").value=isoDate(new Date());
  // Purchase-form defaults.
  $("goldType").value="96.5";
  $("unit").value="baht";
  $("lotForm").addEventListener("submit",addLot);
  if($("buyCalcBtn")) $("buyCalcBtn").addEventListener("click",calcThaiBarFromOz);
  if($("buyCalcOz")) $("buyCalcOz").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); calcThaiBarFromOz(); } });
  ["quantity","cost","unit"].forEach(id=>$(id).addEventListener("input",updateLotPreview));
  $("refreshGoldBtn").addEventListener("click",manualRefreshGold);
  initNews();
  $("exportGoldBtn").addEventListener("click",exportData);
  $("clearGoldBtn").addEventListener("click",clearAll);

  document.querySelectorAll(".simulate-btn").forEach(btn=>{
    btn.addEventListener("click",()=>simulate(Number(btn.dataset.percent)));
  });

  document.querySelectorAll(".chart-tab[data-range]").forEach(btn=>{
    btn.addEventListener("click",()=>setChartRange(btn.dataset.range));
  });

  $("lotsList").addEventListener("click",e=>{
    const btn=e.target.closest(".delete-lot");
    if(btn)deleteLot(btn.dataset.id);
  });

  const lotPageSelect=$("lotPageSelect");
  if(lotPageSelect){
    lotPageSelect.addEventListener("change",()=>{
      selectedLotNumber=Number(lotPageSelect.value)||1;
      renderLots();
      // Keep the portfolio page at the purchase-list section after changing rounds.
      const section=lotPageSelect.closest(".gold-card");
      if(section) section.scrollIntoView({behavior:"smooth",block:"start"});
    });
  }

  const settings=loadSettings();
  state.gold2go={
    receivePrice:Number(settings.gold2goReceiveBaht || settings.gold2goBuyBaht)>0
      ? Number(settings.gold2goReceiveBaht || settings.gold2goBuyBaht) : null,
    sellPrice:sanitizeGold2goSell(settings.gold2goReceiveBaht||settings.gold2goBuyBaht, settings.gold2goSellBaht),
    updatedAt:settings.gold2goUpdatedAt || null,
    source:settings.gold2goPriceSource || null
  };
  $("valuationSource").value=settings.valuationSource==="market" ? "market" : "gold2go";
  $("gold2goBuyBaht").value=settings.gold2goBuyBaht||"";
  updateValuationSourceUI();
  updateGold2goQuoteUI();
  $("valuationSource").addEventListener("change",()=>{
    saveValuationSettings();
    updateValuationSourceUI();
  });
  $("saveGold2goQuoteBtn").addEventListener("click",useManualGold2goPrice);
  $("autoGold2goBtn").addEventListener("click",async()=>{
    const btn=$("autoGold2goBtn");
    if(btn){btn.disabled=true;btn.textContent="⏳ กำลังดึงราคา...";}
    try{
      const s=loadSettings();
      s.gold2goPriceMode="auto";
      saveSettings(s);
      await fetchGold2goAutoPrice(true);
    }finally{
      if(btn){btn.disabled=false;btn.textContent="🟢 ดึงราคา Auto";}
    }
  });

  $("chartFitBtn").addEventListener("click",fitChart);
  $("chartResetBtn").addEventListener("click",resetChartZoom);
  $("chartFullscreenBtn").addEventListener("click",toggleChartFullscreen);
  $("chartCandleBtn").addEventListener("click",()=>setChartMode(chartMode==="line"?"candle":"line"));
  document.querySelectorAll(".chart-interval").forEach(btn=>btn.addEventListener("click",()=>setChartInterval(btn.dataset.interval)));

  // autoSize (ResizeObserver) handles chart resizing; only the overlay needs a redraw.
  window.addEventListener("resize",scheduleOverlay);
  window.addEventListener("orientationchange",()=>setTimeout(scheduleOverlay,300));
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"){
      const wrap=$("chartStageOz")?.closest(".chart-wrap");
      if(wrap?.classList.contains("chart-fullscreen")) toggleChartFullscreen();
    }
  });
  window.addEventListener("pagehide",()=>saveTickStore(true));
  syncChartControls();
  loadLastMarket();
  renderPortfolio();
  renderLots();
  renderChart();

  // Smart polling scheduler.
  // setTimeout is used instead of setInterval so slow requests can never
  // overlap with the next request.
  const runPoll=async(reason="timer")=>{
    if(pollBusy) return;
    pollBusy=true;
    lastPollReason=reason;

    let result=null;
    try{
      result=await fetchGold();
      const g=result?.gold2go;

      if(g?.ok){
        gold2goConsecutiveFailures=0;
      }else if(g?.skipped && g.reason==="manual mode"){
        // Manual mode is not an error; keep the user-entered quote.
      }else if(g && !g.skipped){
        gold2goConsecutiveFailures++;
      }

      if(gold2goConsecutiveFailures>=MAX_CONSECUTIVE_FAILURES){
        // Last Known is already preserved by fetchGold2goAutoPrice().
        // Do not switch the user into Manual automatically; simply expose
        // the Manual control and slow the next automatic attempt.
        setGold2goFallbackStatus(
          `${g?.error||"Auto ดึงราคาไม่สำเร็จ"} · ลองใหม่ช้าลง ${POLL_FAILURE_MS/1000} วินาที`
        );
      }
    }catch(e){
      gold2goConsecutiveFailures++;
      setMarketOffline(e?.message||"Polling error");
    }finally{
      pollBusy=false;

      const hidden=document.visibilityState!=="visible";
      let delay=hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;

      const g=result?.gold2go;
      if(g?.hardBackoff) delay=POLL_BACKOFF_MS;
      else if(gold2goConsecutiveFailures>=MAX_CONSECUTIVE_FAILURES) delay=POLL_FAILURE_MS;

      clearTimeout(pollTimer);
      pollTimer=setTimeout(()=>runPoll("timer"),delay);
    }
  };

  window.__kfpGoldPoll=runPoll;

  // First load immediately.
  runPoll("startup");
  setTimeout(fetchHistoricalGold,1500);
  setInterval(fetchHistoricalGold,30*60*1000);

  // Returning to the page/app: fetch exactly once immediately,
  // then return to the normal 5-second visible cadence.
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible"){
      clearTimeout(pollTimer);
      pollTimer=null;
      runPoll("visible-return");
    }else{
      saveTickStore(true);
      clearTimeout(pollTimer);
      pollTimer=setTimeout(()=>runPoll("background"),POLL_HIDDEN_MS);
    }
  });

  // Desktop browsers can keep visibility "visible" while focus changes.
  window.addEventListener("focus",()=>{
    if(document.visibilityState==="visible"){
      clearTimeout(pollTimer);
      pollTimer=null;
      runPoll("focus");
    }
  });
}

function updateValuationSourceUI(){
  const mode=$("valuationSource").value;
  const fields=$("gold2goQuoteFields");
  const note=$("marketValuationNote");
  if(fields) fields.hidden=mode!=="gold2go";
  if(note) note.hidden=mode!=="market";
  renderPortfolio();
  renderLots();
}

function saveValuationSettings(){
  const s=loadSettings();
  s.valuationSource=$("valuationSource").value==="market" ? "market" : "gold2go";
  saveSettings(s);
}

function saveGold2goQuote(){
  return useManualGold2goPrice();
}
document.addEventListener("DOMContentLoaded",setup);
})();