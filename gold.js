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
    Primary: Gold API (keyless, CORS enabled according to its docs).
    Fallback: goldprice.dev conversion endpoint for XAU -> THB.
  */
  try{
    const data = await fetchJSON("https://api.gold-api.com/price/XAU");
    const spot = Number(data.price);
    if(!Number.isFinite(spot)) throw new Error("Invalid gold price");

    let fx = Number(data.usd_thb || data.usdThb);
    if(!Number.isFinite(fx)){
      const fxData = await fetchJSON("https://api.frankfurter.app/latest?from=USD&to=THB");
      fx = Number(fxData?.rates?.THB);
    }
    if(!Number.isFinite(fx)) throw new Error("Invalid USD/THB");

    applyMarket(spot,fx,"Gold API + FX");
  }catch(primaryError){
    try{
      const data = await fetchJSON("https://api.goldprice.dev/v1/convert?from=XAU&to=THB&amount=1&unit=oz");
      const thbOz = Number(data.result);
      if(!Number.isFinite(thbOz)) throw new Error("Invalid fallback");
      let fx = Number(data.fx_rate);
      if(!Number.isFinite(fx)) {
        try {
          const fxData = await fetchJSON("https://api.frankfurter.app/latest?from=USD&to=THB");
          fx = Number(fxData?.rates?.THB);
        } catch(_) { fx = null; }
      }
      if(!Number.isFinite(fx) || fx <= 0) {
        // We can still display a THB market quote even when FX is unavailable.
        state.priceThbOz=thbOz;
        state.priceThbGram=thbOz/OZ_TO_GRAM;
        state.updatedAt=new Date().toISOString();
        state.source="GoldPrice.dev conversion";
        appendHistory(); renderMarket(); renderPortfolio(); renderLots(); renderChart();
      } else {
        const spot = thbOz / fx;
        applyMarket(spot,fx,"GoldPrice.dev conversion");
      }
    }catch(fallbackError){
      setMarketOffline(`${primaryError.message}`);
      return false;
    }
  }
  return true;
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
    if(x && Number.isFinite(x.priceThbGram)){
      state={...state,...x};
      renderMarket();
    }
  }catch{}
}

function setMarketOffline(message){
  $("marketDot").className="status-dot offline";
  $("marketStatus").textContent="ราคาตลาดออฟไลน์ — ใช้ค่าล่าสุดที่บันทึกไว้";
  if(state.updatedAt) $("marketUpdated").textContent=`ล่าสุด ${new Date(state.updatedAt).toLocaleString("th-TH")}`;
  else $("marketUpdated").textContent="ยังไม่มีข้อมูล";
  const hint=$("chartHint");
  if(hint) hint.textContent="API ยังไม่ตอบสนอง — ข้อมูลพอร์ตยังดูได้ตามปกติ";
  renderPortfolio();
  renderLots();
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
  if(!state.priceThbGram) return;
  const history=loadHistory();
  const now=Date.now();
  const last=history[history.length-1];
  // One point per minute is enough for the personal tracker.
  if(last && now-last.ts < 50_000) return;
  history.push({ts:now,price:state.priceThbGram});
  const cutoff=now-1000*60*60*24*31;
  const trimmed=history.filter(x=>x.ts>=cutoff);
  saveHistory(trimmed.slice(-5000));
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

function renderChart(){
  const canvas=$("goldChart");
  if(!canvas) return;
  const ctx=canvas.getContext("2d");
  const dpr=window.devicePixelRatio||1;
  const rect=canvas.getBoundingClientRect();
  const w=Math.max(300,rect.width),h=Math.max(220,rect.height);
  canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);

  const now=Date.now();
  const days=state.range==="1D"?1:state.range==="7D"?7:30;
  const start=now-days*86400000;
  const pts=loadHistory().filter(x=>x.ts>=start && Number.isFinite(x.price));

  if(pts.length<2){
    ctx.fillStyle="#686868";ctx.font="14px Arial";ctx.textAlign="center";
    ctx.fillText("ยังมีข้อมูลกราฟไม่พอ — เปิดหน้านี้ไว้สักระยะเพื่อสะสมจุดราคา",w/2,h/2);
    return;
  }

  const values=pts.map(x=>x.price);
  let min=Math.min(...values),max=Math.max(...values);
  if(max===min){max+=1;min-=1}
  const pad={l:48,r:14,t:18,b:30};
  const cw=w-pad.l-pad.r,ch=h-pad.t-pad.b;

  ctx.strokeStyle="#292b2b";ctx.lineWidth=1;
  for(let i=0;i<4;i++){
    const y=pad.t+ch*i/3;
    ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();
  }
  ctx.fillStyle="#777";ctx.font="11px Arial";ctx.textAlign="right";
  for(let i=0;i<4;i++){
    const v=max-(max-min)*i/3;
    ctx.fillText(`฿${Math.round(v).toLocaleString()}`,pad.l-7,pad.t+ch*i/3+4);
  }

  ctx.beginPath();
  pts.forEach((p,i)=>{
    const x=pad.l+cw*(i/(pts.length-1));
    const y=pad.t+ch*(1-(p.price-min)/(max-min));
    i?ctx.lineTo(x,y):ctx.moveTo(x,y);
  });
  ctx.strokeStyle="#d4af37";ctx.lineWidth=2;ctx.stroke();

  ctx.lineTo(pad.l+cw,pad.t+ch);ctx.lineTo(pad.l,pad.t+ch);ctx.closePath();
  const grad=ctx.createLinearGradient(0,pad.t,0,pad.t+ch);
  grad.addColorStop(0,"rgba(212,175,55,.22)");grad.addColorStop(1,"rgba(212,175,55,0)");
  ctx.fillStyle=grad;ctx.fill();

  const last=pts[pts.length-1];
  ctx.fillStyle="#6fe08f";ctx.beginPath();
  const lx=pad.l+cw,ly=pad.t+ch*(1-(last.price-min)/(max-min));ctx.arc(lx,ly,4,0,Math.PI*2);ctx.fill();
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
      btn.classList.add("active");state.range=btn.dataset.range;renderChart();
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

  window.addEventListener("resize",renderChart);
  loadLastMarket();
  renderPortfolio();
  renderLots();
  renderChart();
  fetchGold();
  state.timer=setInterval(fetchGold,POLL_MS);
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