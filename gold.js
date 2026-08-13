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
let tvCandleSeries = null;
let tvChartOz = null;
let tvSeriesOz = null;
let tvCandleSeriesOz = null;
let chartMode = "line";
let chartInterval = "5m";
let tvChartReadyKey = null;
const CHART_VIEW_KEY = "kfp_gold_chart_view_v2";
const CHART_INTERVALS = {"5m":5*60*1000,"15m":15*60*1000,"30m":30*60*1000,"1H":60*60*1000,"1D":24*60*60*1000};

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
  const days=state.range==="1D"?1:(state.range==="7D"?7:30);
  const start=now-days*86400000;
  return loadLots().filter(l=>{
    const ts=Date.parse(`${l.date}T${l.time||"00:00"}`);
    return Number.isFinite(ts)&&ts>=start&&ts<=now+86400000;
  });
}
function extendRangeForLots(data){
  if(!data.length)return null;
  const times=data.map(x=>x.time);
  let from=Math.min(...times),to=Math.max(...times);
  const lots=getLotsForChart();
  for(const l of lots){
    const ts=Math.floor(Date.parse(`${l.date}T${l.time||"00:00"}`)/1000);
    if(Number.isFinite(ts)){from=Math.min(from,ts);to=Math.max(to,ts);}
  }
  const span=Math.max(3600,to-from);
  return {from:from-span*0.03,to:to+span*0.03};
}

function rawIntradayPoints(){
  const now=Date.now();
  const remote=(()=>{try{return JSON.parse(localStorage.getItem(INTRADAY_HISTORY_KEY)||"[]")}catch{return []}})();
  return remote.filter(x=>x.ts>=now-86400000&&Number.isFinite(Number(x.price)))
    .concat(loadHistory().filter(x=>x.ts>=now-86400000&&Number.isFinite(Number(x.price))))
    .map(x=>({ts:Number(x.ts),price:Number(x.price)}))
    .filter(x=>Number.isFinite(x.ts)&&Number.isFinite(x.price)&&x.price>0)
    .sort((a,b)=>a.ts-b.ts);
}
function rawDailyPoints(){
  const now=Date.now(),days=state.range==="7D"?7:30,start=now-days*86400000;
  return loadDailyHistory().filter(x=>x.ts>=start&&Number.isFinite(Number(x.price)))
    .map(x=>({ts:Number(x.ts),price:Number(x.price)}))
    .sort((a,b)=>a.ts-b.ts);
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
  const points=state.range==="1D" ? rawIntradayPoints() : rawDailyPoints();
  if(!points.length)return [];
  return state.range==="1D" ? aggregateIntraday(dedupPoints(points),chartInterval) : aggregateDaily(points);
}
function lineDataFromOHLC(data){return data.map(x=>({time:x.time,value:x.close}));}
function scaleOHLC(data,factor){return data.map(x=>({time:x.time,open:x.open*factor,high:x.high*factor,low:x.low*factor,close:x.close*factor}));}
function chartTime(ts){return Math.floor(Number(ts)/1000)}
function formatChartPrice(v,dec=2){return `฿${Number(v).toLocaleString("th-TH",{minimumFractionDigits:dec,maximumFractionDigits:dec})}`}

function ensureTradingViewChart(){
  if(tvChart&&tvChartOz)return true;
  if(!window.LightweightCharts){
    const hint=$("chartHint");if(hint)hint.textContent="กำลังโหลดระบบกราฟ…";return false;
  }
  const makeChart=(id)=>{
    const el=$(id);if(!el)return null;
    return LightweightCharts.createChart(el,{autoSize:true,layout:{background:{type:"solid",color:"#0f1112"},textColor:"#777"},grid:{vertLines:{color:"#171919"},horzLines:{color:"#292b2b"}},rightPriceScale:{borderColor:"#292b2b",scaleMargins:{top:.08,bottom:.08}},timeScale:{borderColor:"#292b2b",timeVisible:true,secondsVisible:false,rightOffset:5,barSpacing:7,minBarSpacing:2},crosshair:{mode:LightweightCharts.CrosshairMode.Normal,vertLine:{color:"#d4af37",width:1,style:2,labelBackgroundColor:"#8f7218"},horzLine:{color:"#d4af37",width:1,style:2,labelBackgroundColor:"#8f7218"}},handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:true,axisDoubleClickReset:true}});
  };
  tvChart=makeChart("goldChart"); tvChartOz=makeChart("goldChartOz");
  if(!tvChart||!tvChartOz)return false;
  const areaOpts={topColor:"rgba(212,175,55,.24)",bottomColor:"rgba(212,175,55,.015)",lineColor:"#d4af37",lineWidth:2,priceLineVisible:true,lastValueVisible:true,crosshairMarkerVisible:true,crosshairMarkerRadius:4,priceFormat:{type:"price",precision:2,minMove:.01}};
  const candleOpts={upColor:"#62db8a",downColor:"#ff5d68",borderUpColor:"#62db8a",borderDownColor:"#ff5d68",wickUpColor:"#62db8a",wickDownColor:"#ff5d68",priceFormat:{type:"price",precision:2,minMove:.01}};
  tvSeries=tvChart.addAreaSeries(areaOpts);tvCandleSeries=tvChart.addCandlestickSeries(candleOpts);
  tvSeriesOz=tvChartOz.addAreaSeries(areaOpts);tvCandleSeriesOz=tvChartOz.addCandlestickSeries(candleOpts);
  setChartMode(chartMode);
  tvChart.timeScale().subscribeVisibleTimeRangeChange(()=>{saveChartView();drawPurchaseOverlays();});
  tvChartOz.timeScale().subscribeVisibleTimeRangeChange(()=>drawPurchaseOverlays());
  const cross=(chart,series,tip,factor)=>chart.subscribeCrosshairMove(param=>{
    if(!param.time||!param.seriesData)return;
    const row=param.seriesData.get(chartMode==="candle"?(factor===1?tvCandleSeriesOz:tvCandleSeries):series);
    const value=row?.value ?? row?.close;
    if(!Number.isFinite(Number(value)))return;
    const d=new Date(Number(param.time)*1000);
    $(tip).textContent=`${d.toLocaleString("th-TH",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})} · ${money(Number(value))}${factor===1?"/g":"/troy oz"}`;
  });
  cross(tvChart,tvSeries,"chartTooltip",OZ_TO_GRAM); // gram chart
  cross(tvChartOz,tvSeriesOz,"chartTooltipOz",1);
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
  if(!values.length){["chartCurrent","chartHigh","chartLow","chartChange"].forEach(id=>$(id).textContent="ปัจจุบัน: -");return;}
  const current=values.at(-1),first=values[0],high=Math.max(...values),low=Math.min(...values),change=first?((current-first)/first)*100:0;
  $("chartCurrent").textContent=`ปัจจุบัน: ${money(current)}/g`;
  $("chartHigh").textContent=`สูงสุด: ${money(high)}/g`;
  $("chartLow").textContent=`ต่ำสุด: ${money(low)}/g`;
  $("chartChange").textContent=`เปลี่ยนแปลง: ${change>=0?"+":""}${change.toFixed(2)}%`;
  $("chartCurrentOz").textContent=`ปัจจุบัน: ${money(current*OZ_TO_GRAM)}/troy oz`;
  $("chartHighOz").textContent=`สูงสุด: ${money(high*OZ_TO_GRAM)}/troy oz`;
  $("chartLowOz").textContent=`ต่ำสุด: ${money(low*OZ_TO_GRAM)}/troy oz`;
  $("chartChangeOz").textContent=`เปลี่ยนแปลง: ${change>=0?"+":""}${change.toFixed(2)}%`;
}
function svgEl(tag,attrs){const e=document.createElementNS("http://www.w3.org/2000/svg",tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e;}
function drawPurchaseOverlay(chart,series,svgId,gramMode){
  const svg=$(svgId);if(!svg||!chart||!series)return;
  const host=svg.parentElement;const w=host?.clientWidth||svg.clientWidth,h=host?.clientHeight||svg.clientHeight;svg.setAttribute("viewBox",`0 0 ${w} ${h}`);svg.innerHTML="";
  const lots=getLotsForChart();
  const visible=chart.timeScale().getVisibleRange();if(!visible)return;
  for(const lot of lots){
    const ts=chartTime(Date.parse(`${lot.date}T${lot.time||"00:00"}`));
    if(!Number.isFinite(ts)||ts<visible.from||ts>visible.to)continue;
    const x=chart.timeScale().timeToCoordinate(ts);if(x==null)continue;
    const grams=Number(lot.grams)||unitToGrams(Number(lot.quantity)||0,lot.unit);
    if(!(grams>0))continue;
    const buyGram=Number(lot.buyPriceThbGram)>0?Number(lot.buyPriceThbGram):(Number(lot.costThb)>0?Number(lot.costThb)/grams:0);
    if(!(buyGram>0))continue;
    const buy=gramMode?buyGram:buyGram*OZ_TO_GRAM;
    const current=Number(state.priceThbGram)||0;
    if(!(current>0))continue;
    const pl=(current-buyGram)*grams;
    const y=series.priceToCoordinate(buy);if(y==null)continue;
    const positive=pl>=0,color=positive?"#62db8a":"#ff5d68";
    const v=svgEl("line",{x1:x,y1:0,x2:x,y2:h,stroke:color,class:"purchase-vline"});
    const hl=svgEl("line",{x1:0,y1:y,x2:w,y2:y,stroke:color,class:"purchase-hline"});
    const dot=svgEl("circle",{cx:x,cy:y,r:6,fill:color,class:"purchase-dot"});
    const labelX=Math.min(Math.max(x+8,8),Math.max(8,w-145));
    const label=svgEl("text",{x:labelX,y:Math.max(16,y-9),fill:color,class:"purchase-label"});label.textContent=`${positive?"+":""}${money(pl)}`;
    const price=svgEl("text",{x:labelX,y:Math.min(h-8,Math.max(30,y+15)),fill:"#d4af37",class:"purchase-sub"});price.textContent=`ซื้อ ${formatChartPrice(buy)}`;
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
  const gramLine=lineDataFromOHLC(pts),gramCandle=pts,ozCandle=scaleOHLC(pts,OZ_TO_GRAM),ozLine=lineDataFromOHLC(ozCandle);
  tvSeries.setData(gramLine);tvCandleSeries.setData(gramCandle);tvSeriesOz.setData(ozLine);tvCandleSeriesOz.setData(ozCandle);
  const key=chartRangeKey();
  if(tvChartReadyKey!==key){restoreChartView();tvChartReadyKey=key;}
  const hint=$("chartHint");
  if(hint){
    const source=state.range==="1D"?`Intraday · ${chartInterval} · ${pts.length} แท่ง`:`ย้อนหลัง ${state.range} · ${pts.length} แท่ง`;
    const candleNote=chartMode==="candle"?(state.range==="1D"?" · OHLC จากจุด Intraday":" · แท่งรายวันเป็นค่าประมาณจากราคาปิด"):" · กราฟเส้น";
    hint.textContent=`ลาก/บีบนิ้วเพื่อเลื่อนและซูม · ${source}${candleNote}`;
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