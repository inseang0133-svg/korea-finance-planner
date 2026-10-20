/* V15 finance compatibility layer
 * Keep the original index.html finance logic intact.
 * Adds only: realtime refresh hardening + deletion persistence/tombstones + V14 storage migration.
 */
const KFP_DELETED_KEYS = "__kfp_deleted_keys_v1";

function kfpReadDeletedKeys(){
    try {
        const x = JSON.parse(localStorage.getItem(KFP_DELETED_KEYS) || "{}");
        return x && typeof x === "object" && !Array.isArray(x) ? x : {};
    } catch (_) { return {}; }
}

function kfpMarkDeleted(key){
    try {
        const x = kfpReadDeletedKeys();
        x[key] = Date.now();
        localStorage.setItem(KFP_DELETED_KEYS, JSON.stringify(x));
    } catch (_) {}
    try { if (typeof window.__kfpPwaPersist === "function") window.__kfpPwaPersist(); } catch (_) {}
}

function kfpClearDeleted(key){
    try {
        const x = kfpReadDeletedKeys();
        if (Object.prototype.hasOwnProperty.call(x, key)) {
            delete x[key];
            localStorage.setItem(KFP_DELETED_KEYS, JSON.stringify(x));
        }
    } catch (_) {}
}

function kfpPersistNow(){
    try { if (typeof window.__kfpPwaPersist === "function") window.__kfpPwaPersist(); } catch (_) {}
}

// V14 stored finance data under isolated keys. Migrate it back to the original
// index.html keys so the original finance module and existing Cloud schema continue to work.
(function migrateV14FinanceKeys(){
    try {
        const deleted = kfpReadDeletedKeys();
        const migrations = [
            ["kfp_salary_records_v2", "salaryRecords"],
            ["kfp_exchange_rate_v1", "rate"],
            ["kfp_exchange_rate_updated_v1", "rateUpdatedAt"],
            ["kfp_contract_v1", "contractStartDate"]
        ];
        for (const [from, to] of migrations) {
            const fromValue = localStorage.getItem(from);
            const isDeleted = Object.prototype.hasOwnProperty.call(deleted, from);
            if (isDeleted) {
                localStorage.removeItem(to);
            } else if (localStorage.getItem(to) === null && fromValue !== null) {
                localStorage.setItem(to, fromValue);
            }
            if (fromValue !== null || isDeleted) localStorage.removeItem(from);
        }
    } catch (_) {}
})();

let salaryChart = null;
let savingChart = null;
let pieChart = null;
function formatNumber(num){
    return new Intl.NumberFormat().format(num);
}

function saveData(){

    localStorage.setItem(
        "salary",
        document.getElementById("salary").value
    );

    localStorage.setItem(
        "rate",
        document.getElementById("rate").value
    );
}

function updateSalaryPreview(){

    const salary =
        Number(
            document.getElementById(
                "salary"
            ).value
        );

    const rate =
        Number(
            document.getElementById(
                "rate"
            ).value
        );

    const preview =
        document.getElementById(
            "salaryTHBPreview"
        );

    if(!salary || !rate){

        preview.innerHTML = "-";

        preview.classList.remove(
            "success"
        );

        return;
    }

    const thb =
        salary * rate;

    preview.innerHTML =
        `≈ ${formatNumber(
            Math.round(thb)
        )} THB`;

    if(thb >= 45725.856){

        preview.classList.add(
            "success"
        );

    }
    else{

        preview.classList.remove(
            "success"
        );
    }
}

function loadData(){

    const salary =
        localStorage.getItem("salary");

    const rate =
        localStorage.getItem("rate");

    if(salary){
        document.getElementById("salary").value =
            salary;
    }

    if(rate){
        document.getElementById("rate").value =
            rate;
    }
    const updatedAt =
    localStorage.getItem(
        "rateUpdatedAt"
    );

if(updatedAt){

    document.getElementById(
        "exchangeStatus"
    ).innerText =
        `อัปเดตล่าสุด ${new Date(updatedAt)
        .toLocaleString("th-TH")}`;

}
}

function calculate(){

    const salary =
        Number(document.getElementById("salary").value);

    const rate =
        Number(document.getElementById("rate").value);

    saveData();

    const saving = salary * 0.45;
    const gold = salary * 0.15;
    const family = salary * 0.25;
    const personal = salary * 0.10;
    const travel = salary * 0.05;

    document.getElementById("saving").innerHTML =
        `${formatNumber(saving)} KRW<br>
        ≈ ${formatNumber((saving*rate).toFixed(0))} THB`;

    document.getElementById("gold").innerHTML =
        `${formatNumber(gold)} KRW<br>
        ≈ ${formatNumber((gold*rate).toFixed(0))} THB`;

    document.getElementById("family").innerHTML =
        `${formatNumber(family)} KRW<br>
        ≈ ${formatNumber((family*rate).toFixed(0))} THB`;

    document.getElementById("personal").innerHTML =
        `${formatNumber(personal)} KRW<br>
        ≈ ${formatNumber((personal*rate).toFixed(0))} THB`;

    document.getElementById("travel").innerHTML =
        `${formatNumber(travel)} KRW<br>
        ≈ ${formatNumber((travel*rate).toFixed(0))} THB`;
 
 renderPieChart();  
 loadSalaryRecords();     
}

function saveGoalData(){

    localStorage.setItem(
        "goal",
        document.getElementById("goal").value
    );

    localStorage.setItem(
        "currentSaving",
        document.getElementById("currentSaving").value
    );

}

function updateGoalTracker(){

    const goal =
        Number(
            document.getElementById("goal").value
        );

    const current =
        Number(
            document.getElementById("currentSaving").value
        );

    saveGoalData();

    if(goal <= 0) return;

    const percent =
        Math.min(
            (current / goal) * 100,
            100
        );

    document.getElementById(
        "progressBar"
    ).style.width =
        percent + "%";

    document.getElementById(
        "progressText"
    ).innerText =
        percent.toFixed(1) + "%";

    const remain =
        goal - current;

    document.getElementById(
        "goalInfo"
    ).innerHTML =
        `
        สะสมแล้ว ${formatNumber(current)} บาท<br>
        เหลืออีก ${formatNumber(remain)} บาท
        `;
}

const goal =
    localStorage.getItem("goal");

const currentSaving =
    localStorage.getItem("currentSaving");

if(goal){
    document.getElementById("goal").value =
        goal;
}

if(currentSaving){
    document.getElementById("currentSaving").value =
        currentSaving;
}

document
.getElementById("goal")
.addEventListener(
    "input",
    updateGoalTracker
);

document
.getElementById("currentSaving")
.addEventListener(
    "input",
    updateGoalTracker
);

function loadSalaryRecords() {
    const records = JSON.parse(localStorage.getItem("salaryRecords") || "[]");
    const historyDiv = document.getElementById("salaryHistory");
    const filterYearSelect = document.getElementById("filterYear");
    
    // เก็บค่าที่ผู้ใช้เลือกปัจจุบันไว้ก่อน เพื่อไม่ให้ดรอปดาวน์เด้งเวลารีโหลด
    const currentSelected = filterYearSelect.value || "latest";

    // 1. 🧠 ระบบสร้างเมนูปีอัตโนมัติ (Dynamic Year Generator)
    // ดึงเฉพาะปี (4 หลักแรก เช่น "2026") ออกมาจากข้อมูลทั้งหมดที่มีในระบบ
    const yearsInRecords = records.map(item => item.month.split("-")[0]);
    // กรองเอาปีที่ซ้ำกันออก ให้เหลือเฉพาะปีที่ไม่ซ้ำกัน
    const uniqueYears = [...new Set(yearsInRecords)];
    // จัดเรียงปีจากใหม่ไปเก่า (เช่น 2027 แล้วค่อย 2026)
    uniqueYears.sort((a, b) => b - a);

    // สร้าง HTML สำหรับดรอปดาวน์ เริ่มต้นด้วย "3 เดือนล่าสุด"
    let selectHTML = `<option value="latest">3 เดือนล่าสุด</option>`;
    // วนลูปเอาปีที่มีข้อมูลจริง ใส่เข้าไปในดรอปดาวน์เพิ่มแบบอัตโนมัติ
    uniqueYears.forEach(year => {
        selectHTML += `<option value="${year}">ปี ${year}</option>`;
    });
    
    // อัปเดตตัวเลือกใน Dropdown หน้าเว็บ
    filterYearSelect.innerHTML = selectHTML;
    
    // ป้องกันกรณีที่เพิ่งลบข้อมูลปีนั้นไปจนหมด ให้เด้งกลับไปที่ "latest"
    if (currentSelected !== "latest" && !uniqueYears.includes(currentSelected)) {
        filterYearSelect.value = "latest";
    } else {
        filterYearSelect.value = currentSelected;
    }

    // ดึงค่าตัวกรองล่าสุดมาทำงานต่อ
    const activeFilter = filterYearSelect.value;

    // จัดเรียงข้อมูลประวัติเงินเดือนจากใหม่ล่าสุดขึ้นก่อน
    records.sort((a, b) => new Date(b.month) - new Date(a.month));

    let displayRecords = [...records];

    // 2. กรองข้อมูลที่จะแสดงผลบนหน้าจอ
    if (activeFilter === "latest") {
        displayRecords = records.slice(0, 3);
    } else {
        displayRecords = records.filter(item => item.month.startsWith(activeFilter));
    }

    if (displayRecords.length === 0) {
        historyDiv.innerHTML = `<p style="color: #666; text-align: center; font-size: 14px; padding: 15px 0;">ไม่มีข้อมูลสำหรับช่วงเวลานี้</p>`;
        return;
    }

    
    // 3. แสดงผลรายการประวัติเงินเดือนออกหน้าจอ
    historyDiv.innerHTML = displayRecords.map((item) => {
        // หาตำแหน่ง index ที่แท้จริงของข้อมูลชิ้นนี้ในอาเรย์หลักเพื่อใช้สั่งลบ
        const originalIndex = records.findIndex(r => r.month === item.month && r.salary === item.salary);
        
        const date = new Date(item.month + "-01");
        const monthName = date.toLocaleDateString("th-TH", { month: "long", year: "numeric" });
        
        // อัปเกรดแบบถูกต้อง: ดึงค่าเรตที่เคยถูกล็อกไว้ในอดีตของเดือนนั้นๆ มาคำนวณ
        // (และใส่ระบบป้องกันไว้ว่าถ้าเป็นรายการเก่ามากๆ ที่ไม่มีค่า rate ให้ใช้เรตหน้าจอไปก่อน)
        const savedRate = item.rate || Number(document.getElementById("rate").value) || 0.0240;
        
        // คำนวณเงินบาทโดยใช้เรต ณ วันที่กดบันทึกจริงในอดีต
        const thbSalary = item.salary * savedRate;
        
        return `
            <div class="history-item" style="display: flex; justify-content: space-between; align-items: center; background: #222; padding: 12px 15px; border-radius: 8px; margin-bottom: 10px; border-left: 3px solid #d4af37;">
                <div>
                    <span style="font-weight: bold; display: block; font-size: 15px;">${monthName}</span>
                    <span style="color: #aaa; font-size: 13px;">
                        ${formatNumber(item.salary)} KRW 
                        <span style="color: #2ecc71; font-weight: bold; margin-left: 6px;">
                            (≈ ${formatNumber(thbSalary.toFixed(0))} THB)
                        </span>
                    </span>
                </div>
                <button onclick="deleteSalaryRecord(${originalIndex})" style="width: auto; padding: 6px 12px; background: #dd4b39; color: white; border: none; border-radius: 5px; font-size: 12px; cursor: pointer;">❌ ลบ</button>
            </div>
        `;
    }).join("");
}

function deleteSalaryRecord(index){
    
    const records =
    getSalaryRecords();
        

    if(
        !confirm("ต้องการลบรายการนี้ใช่หรือไม่?")
    ){
        return;
    }

    records.splice(index, 1);
    

    localStorage.setItem(
    "salaryRecords",
    JSON.stringify(records)
);

    if(records.length === 0) kfpMarkDeleted("salaryRecords");
    else kfpClearDeleted("salaryRecords");
    kfpPersistNow();

    updateAnalytics();

    loadSalaryRecords();
}



function updateAnalytics(){
    const records =
        getSalaryRecords();
    

    if(records.length === 0){

        // element เหล่านี้ไม่มีใน index.html: ต้องเช็ก null ก่อน
        // ไม่เช่นนั้น window.onload จะหยุดกลางทาง (ทำให้ไม่ได้อัปเดตเรตอัตโนมัติ)
        const emptyTargets = [
            ["avgSalary", "0 KRW"],
            ["avgSaving", "0 KRW"],
            ["monthsToGoal", "-"]
        ];

        emptyTargets.forEach(([id, text]) => {
            const el = document.getElementById(id);
            if(el) el.innerText = text;
        });

        kfpSyncGoalFromSaving(0);
        renderChart();
        renderSavingChart();
        return;
    }


    const totalSalary =
    records.reduce(
        (sum,item)=>
        sum + item.salary,
        0
    );

const totalSaving =
    totalSalary * 0.45;

const totalFamily =
    totalSalary * 0.25;

const totalGold =
    totalSalary * 0.15;

const totalPersonal =
    totalSalary * 0.10;

const totalTravel =
    totalSalary * 0.05;

const totalSalaryTHB =
    records.reduce(
        (sum,item)=>
        sum +
        (
            item.salary *
            (item.rate || 0)
        ),
        0
    );

const totalSavingTHB =
    totalSalaryTHB * 0.45;

const totalFamilyTHB =
    totalSalaryTHB * 0.25;

const totalGoldTHB =
    totalSalaryTHB * 0.15;

const totalPersonalTHB =
    totalSalaryTHB * 0.10;

const totalTravelTHB =
    totalSalaryTHB * 0.05;
document.getElementById(
    "totalSalaryKRW"
).innerText =
    formatNumber(
        Math.round(totalSalary)
    ) + " KRW";

document.getElementById(
    "totalSalaryTHB"
).innerText =
    "≈ " +
    formatNumber(
        Math.round(totalSalaryTHB)
    ) +
    " THB";


document.getElementById(
    "totalSavingKRW"
).innerText =
    formatNumber(
        Math.round(totalSaving)
    ) + " KRW";

document.getElementById(
    "totalSavingTHB"
).innerText =
    "≈ " +
    formatNumber(
        Math.round(totalSavingTHB)
    ) +
    " THB";


document.getElementById(
    "totalFamilyKRW"
).innerText =
    formatNumber(
        Math.round(totalFamily)
    ) + " KRW";

document.getElementById(
    "totalFamilyTHB"
).innerText =
    "≈ " +
    formatNumber(
        Math.round(totalFamilyTHB)
    ) +
    " THB";


document.getElementById(
    "totalGoldKRW"
).innerText =
    formatNumber(
        Math.round(totalGold)
    ) + " KRW";

document.getElementById(
    "totalGoldTHB"
).innerText =
    "≈ " +
    formatNumber(
        Math.round(totalGoldTHB)
    ) +
    " THB";


document.getElementById(
    "totalPersonalKRW"
).innerText =
    formatNumber(
        Math.round(totalPersonal)
    ) + " KRW";

document.getElementById(
    "totalPersonalTHB"
).innerText =
    "≈ " +
    formatNumber(
        Math.round(totalPersonalTHB)
    ) +
    " THB";


document.getElementById(
    "totalTravelKRW"
).innerText =
    formatNumber(
        Math.round(totalTravel)
    ) + " KRW";

document.getElementById(
    "totalTravelTHB"
).innerText =
    "≈ " +
    formatNumber(
        Math.round(totalTravelTHB)
    ) +
    " THB";
    kfpSyncGoalFromSaving(totalSavingTHB);
    renderChart();
    renderSavingChart();

}

// เงินสะสมปัจจุบัน (เป้าหมายเงินเก็บ) = "เงินเก็บ 45%" ในสถิติการเงิน (หน่วยบาท) อัตโนมัติ
function kfpSyncGoalFromSaving(totalSavingTHB){
    const el = document.getElementById("currentSaving");
    if(!el) return;
    el.value = Math.round(Number(totalSavingTHB) || 0);
    try{ updateGoalTracker(); }catch(_){}
}

/* =========================================================
   Charts (index page) — rewritten for stability
   - ไม่ผูกกับ chartjs-plugin-datalabels (ใช้ plugin เล็กๆ ในไฟล์นี้แทน)
   - ทุกกราฟอยู่ใน container ความสูงคงที่ + maintainAspectRatio:false
   - ปิด animation เพื่อกันกราฟค้างครึ่งทางบน iOS PWA
   - ไม่แตะ logic การคำนวณ/การบันทึกข้อมูลใดๆ
   ========================================================= */
const KFP_GOLD = "#d4af37";
const KFP_GOLD_LIGHT = "#f3d870";

function kfpChartReady(){
    return typeof Chart !== "undefined";
}

function kfpEnsureChartLib(cb){
    if(kfpChartReady()){ cb(); return; }
    // CDN หลักโหลดไม่ขึ้น -> ลองสำรองหนึ่งครั้ง แล้ววาดใหม่เมื่อพร้อม
    if(!window.__kfpChartFallbackTried){
        window.__kfpChartFallbackTried = true;
        const s = document.createElement("script");
        s.src = "https://unpkg.com/chart.js@4.4.7/dist/chart.umd.js";
        s.onload = () => { try{ cb(); }catch(e){ console.warn(e); } };
        document.head.appendChild(s);
    }
}

function kfpMonthLabel(ym){
    try{
        const [y,m] = ym.split("-").map(Number);
        return new Date(y, m-1, 1).toLocaleDateString("th-TH", { month:"short", year:"2-digit" });
    }catch(_){ return ym; }
}

function kfpCompact(n){
    const v = Math.abs(n);
    if(v >= 1e6) return (n/1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/,"") + "M";
    if(v >= 1e3) return (n/1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/,"") + "k";
    return String(Math.round(n));
}

// ข้อมูลรายเดือน (เรียงเก่า -> ใหม่) ในหน่วยบาท โดยใช้เรตที่ล็อกไว้ของแต่ละเดือน
// (เหมือนกับที่การ์ด "สถิติการเงิน" ใช้: item.rate || 0)
function kfpMonthlySeries(){
    const rows = [...getSalaryRecords()].sort((a,b)=> a.month.localeCompare(b.month));
    let cumSaving = 0;
    return rows.map(r => {
        const thb = (Number(r.salary)||0) * (Number(r.rate)||0);
        const savingThb = thb * 0.45;
        cumSaving += savingThb;
        return {
            month: r.month,
            label: kfpMonthLabel(r.month),
            krw: Number(r.salary)||0,
            rate: Number(r.rate)||0,
            thb,
            savingThb,
            cumSavingThb: cumSaving,
            cumSavingKrw: 0
        };
    }).map((x,i,arr)=>{
        x.cumSavingKrw = arr.slice(0,i+1).reduce((s,y)=> s + y.krw*0.45, 0);
        return x;
    });
}

// plugin วาดตัวเลขเหนือแท่ง/จุด (แทน datalabels)
const kfpValueLabels = {
    id: "kfpValueLabels",
    afterDatasetsDraw(chart, args, opts){
        if(!opts || opts.display === false) return;
        const meta = chart.getDatasetMeta(0);
        if(!meta || meta.hidden) return;
        const data = chart.data.datasets[0].data;
        if(data.length > (opts.maxItems || 8)) return;
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.font = "600 11px Prompt, system-ui, sans-serif";
        ctx.fillStyle = opts.color || "#f4f1e8";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        meta.data.forEach((el, i) => {
            const v = data[i];
            if(!Number.isFinite(v) || v <= 0) return;
            const pos = el.tooltipPosition ? el.tooltipPosition() : { x: el.x, y: el.y };
            let y = pos.y - 8;
            if(y < chartArea.top + 12) y = chartArea.top + 12;
            ctx.fillText(opts.format ? opts.format(v) : String(v), pos.x, y);
        });
        ctx.restore();
    }
};

function kfpBaseScales(){
    return {
        x: {
            grid: { display:false },
            border: { color:"rgba(212,175,55,.25)" },
            ticks: { color:"#9b978c", font:{ size:11, family:"Prompt, system-ui, sans-serif" } }
        },
        y: {
            beginAtZero: true,
            grace: "12%",
            border: { display:false },
            grid: { color:"rgba(212,175,55,.10)" },
            ticks: {
                color:"#9b978c",
                font:{ size:11, family:"Prompt, system-ui, sans-serif" },
                maxTicksLimit: 5,
                callback: v => "฿" + kfpCompact(v)
            }
        }
    };
}

function kfpTooltipStyle(){
    return {
        backgroundColor:"rgba(20,20,22,.96)",
        borderColor:"rgba(212,175,55,.55)",
        borderWidth:1,
        titleColor:KFP_GOLD_LIGHT,
        bodyColor:"#f4f1e8",
        padding:10,
        cornerRadius:10,
        displayColors:false,
        titleFont:{ family:"Prompt, system-ui, sans-serif", weight:"600" },
        bodyFont:{ family:"Prompt, system-ui, sans-serif" }
    };
}

function kfpShowChartEmpty(canvasId, show, text){
    const c = document.getElementById(canvasId);
    if(!c) return;
    const wrap = c.parentElement;
    if(!wrap) return;
    let msg = wrap.querySelector(".chart-empty");
    if(show){
        if(!msg){
            msg = document.createElement("div");
            msg.className = "chart-empty";
            wrap.appendChild(msg);
        }
        msg.textContent = text || "ยังไม่มีข้อมูล";
        c.style.visibility = "hidden";
    }else{
        if(msg) msg.remove();
        c.style.visibility = "visible";
    }
}

function renderChart(){
    const canvas = document.getElementById("salaryChart");
    if(!canvas) return;

    if(!kfpChartReady()){
        kfpEnsureChartLib(renderChart);
        kfpShowChartEmpty("salaryChart", true, "กำลังโหลดกราฟ…");
        return;
    }

    if(salaryChart){ salaryChart.destroy(); salaryChart = null; }

    const rows = kfpMonthlySeries();
    if(rows.length === 0){
        kfpShowChartEmpty("salaryChart", true, "ยังไม่มีข้อมูลรายได้ · เพิ่มรายการเพื่อดูกราฟ");
        return;
    }
    kfpShowChartEmpty("salaryChart", false);

    const ctx = canvas.getContext("2d");
    salaryChart = new Chart(ctx, {
        type: "bar",
        plugins: [kfpValueLabels],
        data: {
            labels: rows.map(r => r.label),
            datasets: [{
                label: "รายได้ (THB)",
                data: rows.map(r => Math.round(r.thb)),
                borderRadius: 10,
                borderSkipped: false,
                maxBarThickness: 46,
                borderWidth: 1,
                borderColor: "rgba(243,216,112,.9)",
                backgroundColor: function(c){
                    const { chart } = c;
                    const area = chart.chartArea;
                    if(!area) return KFP_GOLD;
                    const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
                    g.addColorStop(0, "rgba(243,216,112,.95)");
                    g.addColorStop(1, "rgba(168,132,31,.55)");
                    return g;
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: { padding: { top: 18, right: 6 } },
            scales: kfpBaseScales(),
            plugins: {
                legend: { display:false },
                kfpValueLabels: {
                    maxItems: 8,
                    color: "#f3d870",
                    format: v => "฿" + kfpCompact(v)
                },
                tooltip: Object.assign(kfpTooltipStyle(), {
                    callbacks: {
                        title: items => rows[items[0].dataIndex].label,
                        label: item => {
                            const r = rows[item.dataIndex];
                            return [
                                "รายได้: " + formatNumber(Math.round(r.thb)) + " THB",
                                formatNumber(r.krw) + " KRW",
                                "เรต 1 KRW = " + (r.rate ? r.rate.toFixed(4) : "-") + " THB"
                            ];
                        }
                    }
                })
            }
        }
    });
}

function renderSavingChart(){
    const canvas = document.getElementById("savingChart");
    if(!canvas) return;

    if(!kfpChartReady()){
        kfpEnsureChartLib(renderSavingChart);
        kfpShowChartEmpty("savingChart", true, "กำลังโหลดกราฟ…");
        return;
    }

    if(savingChart){ savingChart.destroy(); savingChart = null; }

    const rows = kfpMonthlySeries();
    if(rows.length === 0){
        kfpShowChartEmpty("savingChart", true, "ยังไม่มีข้อมูลเงินเก็บสะสม");
        return;
    }
    kfpShowChartEmpty("savingChart", false);

    const ctx = canvas.getContext("2d");
    savingChart = new Chart(ctx, {
        type: "line",
        plugins: [kfpValueLabels],
        data: {
            labels: rows.map(r => r.label),
            datasets: [{
                label: "เงินเก็บสะสม 45% (THB)",
                data: rows.map(r => Math.round(r.cumSavingThb)),
                tension: 0.35,
                fill: true,
                borderColor: KFP_GOLD_LIGHT,
                borderWidth: 3,
                pointRadius: 5,
                pointHoverRadius: 7,
                pointBackgroundColor: KFP_GOLD,
                pointBorderColor: "#0a0a0b",
                pointBorderWidth: 2,
                backgroundColor: function(c){
                    const { chart } = c;
                    const area = chart.chartArea;
                    if(!area) return "rgba(212,175,55,.2)";
                    const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
                    g.addColorStop(0, "rgba(243,216,112,.38)");
                    g.addColorStop(1, "rgba(212,175,55,0)");
                    return g;
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: { padding: { top: 18, right: 14, left: 2 } },
            scales: (function(){
                const sc = kfpBaseScales();
                sc.x.offset = true;   // จุดเดียวก็อยู่กลางกราฟ ไม่ติดขอบ
                return sc;
            })(),
            plugins: {
                legend: { display:false },
                kfpValueLabels: {
                    maxItems: 8,
                    color: "#f3d870",
                    format: v => "฿" + kfpCompact(v)
                },
                tooltip: Object.assign(kfpTooltipStyle(), {
                    callbacks: {
                        title: items => rows[items[0].dataIndex].label,
                        label: item => {
                            const r = rows[item.dataIndex];
                            return [
                                "สะสม: " + formatNumber(Math.round(r.cumSavingThb)) + " THB",
                                "เดือนนี้ +" + formatNumber(Math.round(r.savingThb)) + " THB",
                                "(" + formatNumber(Math.round(r.cumSavingKrw)) + " KRW)"
                            ];
                        }
                    }
                })
            }
        }
    });
}
async function updateExchangeRate(){

    const status =
        document.getElementById(
            "exchangeStatus"
        );

    try{

        status.innerText =
            "กำลังดึงค่าเงิน...";

        const response =
            await fetch(
                "https://open.er-api.com/v6/latest/KRW"
            );

        if(!response.ok){
            throw new Error("HTTP " + response.status);
        }

        const data =
            await response.json();

        const thbRate =
            Number(data && data.rates && data.rates.THB);

        if(!Number.isFinite(thbRate) || thbRate <= 0){
            throw new Error("Invalid THB rate");
        }

        document.getElementById(
            "rate"
        ).value =
            thbRate.toFixed(4);

        localStorage.setItem(
            "rate",
            thbRate.toFixed(4)
        );

        const now = new Date();

        localStorage.setItem(
            "rateUpdatedAt",
            now.toISOString()
        );

        status.innerText =
            `อัปเดตล่าสุด ${now.toLocaleString("th-TH")}
            | 1 KRW = ${thbRate.toFixed(4)} THB`;

        // รีเฟรชหน้าจอแยกจากการดึงเรต เพื่อไม่ให้ error ฝั่ง UI ถูกแสดงว่า "ดึงค่าเงินไม่ได้"
        try{
            updateSalaryPreview();
            convertCurrency();
            renderQuickConvert();
        }
        catch(uiError){
            console.warn("rate UI refresh:", uiError);
        }

        kfpPersistNow();

    }
    catch(error){

        console.error(error);

        status.innerText =
            "ไม่สามารถดึงค่าเงินได้";

    }

}

function exportExcel() {
    const records = JSON.parse(localStorage.getItem("salaryRecords") || "[]");
    if (records.length === 0) {
        alert("ไม่มีข้อมูลที่จะส่งออก");
        return;
    }

    // แก้ไขตรงก้อนนี้ครับ: ดึงค่า item.rate ที่บันทึกไว้ในอดีตมาคำนวณใน Excel ด้วย
    const excelData = records.map(item => {
        // ดึงเรตที่ล็อกไว้ในแต่ละเดือนมาใช้ ถ้าไม่มีค่อยใช้เรตหน้าจอเป็นค่าสำรอง
        const savedRate = item.rate || Number(document.getElementById("rate").value) || 0.0240;
        const thbSalary = item.salary * savedRate;
        
        return {
            "เดือน": item.month,
            "รายได้ (KRW)": item.salary,
            "เรตแลกเปลี่ยน": savedRate, // เพิ่มคอลัมน์บอกเรตประวัติศาสตร์ให้ดูง่าย ๆ
            "รายได้ (THB)": Math.round(thbSalary)
        };
    });

    const worksheet = XLSX.utils.json_to_sheet(excelData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "ประวัติรายได้");

    XLSX.writeFile(workbook, "ประวัติเงินเดือนเกาหลี.xlsx");
}

function convertCurrency(){

    const amount =
        parseFloat(
            document.getElementById(
                "convertAmount"
            ).value
        );

    const rate =
        parseFloat(
            document.getElementById(
                "rate"
            ).value
        );

    const type =
        document.getElementById(
            "convertType"
        ).value;

    let result;

    if(type === "KRW_TO_THB"){

        result =
            amount * rate;

        document.getElementById(
            "convertResult"
        ).innerHTML =
            `
            ${result.toLocaleString()}
            THB
            `;

    }
    else{

        result =
            amount / rate;

        document.getElementById(
            "convertResult"
        ).innerHTML =
            `
            ${Math.round(result)
            .toLocaleString()}
            KRW
            `;

    }

}

function swapConverter(){

    const select =
        document.getElementById(
            "convertType"
        );

    if(
        select.value ===
        "KRW_TO_THB"
    ){

        select.value =
            "THB_TO_KRW";

    }
    else{

        select.value =
            "KRW_TO_THB";

    }

    convertCurrency();

}

function renderQuickConvert(){

    const rate =
        parseFloat(
            document.getElementById(
                "rate"
            ).value
        );

    const amounts = [

        100000,
        500000,
        1000000,
        2000000

    ];

    const grid =
        document.getElementById(
            "quickConvertGrid"
        );

    if(!grid) return;

    grid.innerHTML = "";

    amounts.forEach(amount=>{

        const thb =
            amount * rate;

        grid.innerHTML +=
        `
        <div class="quick-card">

            <strong>
            ${amount.toLocaleString()}
            KRW
            </strong>

            <br><br>

            ≈

            <br><br>

            ${Math.round(thb)
            .toLocaleString()}
            THB

        </div>
        `;

    });

}

function calculateRemit(){

    const thb =
        parseFloat(
            document.getElementById(
                "receiveTHB"
            ).value
        );

    const transferFee =
        parseFloat(
            document.getElementById(
                "transferFee"
            ).value
        ) || 0;

    // ค่าธรรมเนียมรับเงินปลายทางเป็นค่าคงที่ 60 THB
    // และต้องแปลงเป็น KRW ตามเรตสำหรับการส่งเงินจริง
    // ดังนั้นเมื่อเปลี่ยน remitRate ค่า receiveFee จะเปลี่ยนตามทันที
    const receiveFeeTHB = 60;

    // เรตของธนาคารสำหรับการส่งเงินจริง:
    // 1 THB = กี่ KRW
    const remitRate =
        parseFloat(
            document.getElementById(
                "remitRate"
            ).value
        );

    if(
        !thb ||
        !remitRate ||
        remitRate <= 0
    ){
        document.getElementById("remitResult").innerHTML = "-";
        return;
    }

    // ค่าธรรมเนียมรับเงินปลายทาง 60 THB แปลงเป็น KRW ด้วยเรตเดียวกับการส่งเงินจริง
    const receiveFee = Math.round(receiveFeeTHB * remitRate);

    // อัปเดตช่องค่าธรรมเนียมรับเงินปลายทางให้เห็นค่าที่คำนวณจากเรตล่าสุด
    const receiveFeeInput = document.getElementById("receiveFee");
    if (receiveFeeInput) {
        receiveFeeInput.value = receiveFee;
    }

    // จำนวน KRW ที่ต้องส่งเพื่อให้ปลายทางได้รับ THB ตามที่กำหนด
    const krwForRecipient = thb * remitRate;

    // รวมค่าธรรมเนียม
    const totalFee = transferFee + receiveFee;

    // ยอด KRW ที่ต้องโอนจริง
    const krwNeeded = krwForRecipient + totalFee;

    // แสดงเฉพาะข้อมูลสรุปที่จำเป็น
    document.getElementById(
        "remitResult"
    ).innerHTML =
    `
    <div>
        <strong>ค่าธรรมเนียมรวม: ${Math.round(totalFee).toLocaleString()} KRW</strong>
    </div>
    <br>
    <div style="font-size:1.25em;">
        <strong>ต้องโอนประมาณ ${Math.round(krwNeeded).toLocaleString()} KRW</strong>
    </div>
    `;
}

function renderPieChart(){
    const canvas = document.getElementById("pieChart");
    if(!canvas) return;

    if(!kfpChartReady()){
        kfpEnsureChartLib(renderPieChart);
        kfpShowChartEmpty("pieChart", true, "กำลังโหลดกราฟ…");
        return;
    }

    if(pieChart){ pieChart.destroy(); pieChart = null; }

    const salary = Number(document.getElementById("salary").value) || 0;
    const rate = Number(document.getElementById("rate").value) || 0;

    if(salary <= 0){
        kfpShowChartEmpty("pieChart", true, "กรอกเงินเดือนแล้วกด “คำนวณ”");
        return;
    }
    kfpShowChartEmpty("pieChart", false);

    const dataValues = [
        { name: "เงินเก็บ",   label: "💰 เงินเก็บ 45%",   krw: salary * 0.45 },
        { name: "ออมทอง",    label: "🥇 ออมทอง 15%",    krw: salary * 0.15 },
        { name: "ส่งบ้าน",    label: "🏠 ส่งบ้าน 25%",    krw: salary * 0.25 },
        { name: "ใช้ส่วนตัว", label: "🛒 ใช้ส่วนตัว 10%", krw: salary * 0.10 },
        { name: "เที่ยว",     label: "✈️ เที่ยว 5%",      krw: salary * 0.05 }
    ];

    // plugin เล็กๆ วางยอดเงินบาทบนชิ้นเค้ก (ไม่ต้องพึ่ง chartjs-plugin-datalabels)
    const pieLabels = {
        id: "kfpPieLabels",
        afterDatasetsDraw(chart){
            const meta = chart.getDatasetMeta(0);
            const { ctx } = chart;
            ctx.save();
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = "#141416";
            ctx.font = "700 11px Prompt, system-ui, sans-serif";
            meta.data.forEach((arc, i) => {
                const frac = dataValues[i].krw / salary;
                if(frac < 0.07) return;               // ชิ้นเล็กเกินไปไม่วาดตัวเลข
                const p = arc.tooltipPosition();
                ctx.fillText(formatNumber(Math.round(dataValues[i].krw * rate)), p.x, p.y - 7);
                ctx.font = "600 9px Prompt, system-ui, sans-serif";
                ctx.fillText("THB", p.x, p.y + 6);
                ctx.font = "700 11px Prompt, system-ui, sans-serif";
            });
            ctx.restore();
        }
    };

    pieChart = new Chart(canvas.getContext("2d"), {
        type: "pie",
        plugins: [pieLabels],
        data: {
            labels: dataValues.map(item => item.name),
            datasets: [{
                data: dataValues.map(item => item.krw),
                backgroundColor: ["#36a2eb", "#ff6384", "#ff9f40", "#ffcd56", "#4bc0c0"],
                borderColor: "#141416",
                borderWidth: 3,
                hoverOffset: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: { padding: 6 },
            plugins: {
                legend: {
                    position: "bottom",
                    labels: {
                        color: "#f4f1e8",
                        boxWidth: 12,
                        padding: 12,
                        font: { family: "Prompt, system-ui, sans-serif", size: 12 }
                    }
                },
                tooltip: Object.assign(kfpTooltipStyle(), {
                    callbacks: {
                        title: items => dataValues[items[0].dataIndex].label,
                        label: item => {
                            const d = dataValues[item.dataIndex];
                            return [
                                formatNumber(d.krw.toFixed(1)) + " KRW",
                                "≈ " + formatNumber((d.krw * rate).toFixed(0)) + " THB"
                            ];
                        }
                    }
                })
            }
        }
    });
}

// ระยะเวลาสัญญา (เดือน) เก็บเฉพาะในเครื่อง: 22 = 1 ปี 10 เดือน, 36 = 3 ปี, 58 = 4 ปี 10 เดือน
const CONTRACT_MONTHS_KEY = "contractMonths";
const CONTRACT_DEFAULT_MONTHS = 58;
const CONTRACT_OPTIONS = [22, 36, 58];

function getContractMonths(){
    const n = Number(localStorage.getItem(CONTRACT_MONTHS_KEY));
    return CONTRACT_OPTIONS.includes(n) ? n : CONTRACT_DEFAULT_MONTHS;
}

function contractDurationLabel(months){
    const y = Math.floor(months / 12), m = months % 12;
    return [y ? y + " ปี" : "", m ? m + " เดือน" : ""].filter(Boolean).join(" ");
}

function kfpParseLocalDate(str){
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str || ""));
    if(!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// บวกเดือนแบบไม่ให้วันที่ล้นเดือน (เช่น 31 ม.ค. + 1 เดือน = 28/29 ก.พ.)
function kfpAddMonths(date, months){
    const d = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(date.getDate(), lastDay));
    return d;
}

function kfpDiffYMD(from, to){
    let y = to.getFullYear() - from.getFullYear();
    let m = to.getMonth() - from.getMonth();
    let d = to.getDate() - from.getDate();
    if(d < 0){
        m--;
        d += new Date(to.getFullYear(), to.getMonth(), 0).getDate();
    }
    if(m < 0){ y--; m += 12; }
    return { y, m, d };
}

function kfpRemainingText(end){
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if(end <= today) return "ครบสัญญาแล้ว";
    const { y, m, d } = kfpDiffYMD(today, end);
    const parts = [];
    if(y) parts.push(y + " ปี");
    if(m) parts.push(m + " เดือน");
    if(d) parts.push(d + " วัน");
    return parts.length ? parts.join(" ") : "ไม่ถึง 1 วัน";
}

function updateContractButtons(){
    const cur = getContractMonths();
    document.querySelectorAll(".contract-opt").forEach(btn => {
        btn.classList.toggle("active", Number(btn.dataset.months) === cur);
    });
}

function setContractDuration(months){
    if(!CONTRACT_OPTIONS.includes(months)) return;
    localStorage.setItem(CONTRACT_MONTHS_KEY, String(months));
    updateContractButtons();

    // ถ้าเลือกวันเริ่มงานไว้ในช่องแล้ว (แม้ยังไม่ได้กดบันทึก) ให้บันทึกและคำนวณให้เลย
    const input = document.getElementById("startDate").value;
    if(input){
        localStorage.setItem("contractStartDate", input);
        kfpClearDeleted("contractStartDate");
        kfpPersistNow();
        loadContract();
    }else if(localStorage.getItem("contractStartDate")){
        loadContract();
    }else{
        alert("กรุณาเลือกวันเริ่มงานก่อน");
    }
}

function loadContract(){

    updateContractButtons();

    const savedDate =
        localStorage.getItem(
            "contractStartDate"
        );

    if(!savedDate){
        return;
    }

    document.getElementById(
        "startDate"
    ).value =
        savedDate;

    const start = kfpParseLocalDate(savedDate);
    if(!start){
        return;
    }

    const months = getContractMonths();
    const end = kfpAddMonths(start, months);
    const remainText = kfpRemainingText(end);

    document.getElementById(
        "contractResult"
    ).innerHTML =
    `
    <div style="
        background:#222;
        padding:15px;
        border-radius:10px;
        border:1px solid #d4af37;
    ">
        <div>
            <strong>
            วันครบสัญญาจ้าง
            </strong>
            <span style="color:#a9a69c;font-size:13px;">
            (${contractDurationLabel(months)})
            </span>
        </div>

        <br>

        <div style="
            color:#37d478;
            font-size:20px;
            font-weight:bold;
        ">
            ${
                end.toLocaleDateString(
                    "th-TH",
                    {
                        day:"numeric",
                        month:"long",
                        year:"numeric"
                    }
                )
            }
        </div>

        <br>

        <div>
            ${remainText === "ครบสัญญาแล้ว" ? "" : "เหลืออีก"}
            <strong>
            ${remainText}
            </strong>
        </div>
    </div>
    `;
}

function deleteContract(){

    if(
        !confirm(
            "ต้องการลบข้อมูลสัญญาหรือไม่?"
        )
    ){
        return;
    }

    localStorage.removeItem(
        "contractStartDate"
    );
    kfpMarkDeleted("contractStartDate");
    kfpPersistNow();

    document.getElementById(
        "startDate"
    ).value = "";

    document.getElementById(
        "contractResult"
    ).innerHTML = "-";
}

function saveContract(){

    const startDate =
        document.getElementById(
            "startDate"
        ).value;

    if(!startDate){

        alert(
            "กรุณาเลือกวันเริ่มงาน"
        );

        return;
    }

    localStorage.setItem(
        "contractStartDate",
        startDate
    );
    kfpClearDeleted("contractStartDate");
    kfpPersistNow();

    loadContract();
}

function addSalaryRecord() {
    const month = document.getElementById("salaryMonth").value;
    const salary = Number(document.getElementById("salaryRecord").value);
    
    // ดึงค่าเรตเงินปัจจุบัน ณ วินาทีที่กดบันทึกรายการ
    const rate = Number(document.getElementById("rate").value) || 0.0240;

    if (!month || !salary) {
        alert("กรุณากรอกข้อมูลให้ครบถ้วน");
        return;
    }

    const records =
    getSalaryRecords();
    const exists =
    records.some(
        item => item.month === month
    );

    if(exists){
        alert("เดือนนี้มีข้อมูลแล้ว");
        return;
    }
    
    // อัปเกรด: บันทึกค่าเงิน (rate) ล็อกพ่วงติดไปกับเดือนและเงินวอนเลย
    records.push({ month, salary, rate });
    
    localStorage.setItem("salaryRecords", JSON.stringify(records));
    kfpClearDeleted("salaryRecords");
    kfpPersistNow();

    document.getElementById("filterYear").value = "latest"; 
    
    

updateAnalytics();

loadSalaryRecords();

updateGoalTracker();
    
    document.getElementById("salaryRecord").value = "";
}

// ปุ่ม "บันทึกเงินเดือนเดือนนี้" (ข้างปุ่มคำนวณ): บันทึกยอดในช่องเงินเดือนสุทธิเป็นรายการของเดือนปัจจุบัน
function saveThisMonthSalary(){
    const status = document.getElementById("saveMonthStatus");
    const setStatus = (text, cls) => {
        if(!status) return;
        status.textContent = text;
        status.className = "save-month-status " + (cls || "");
    };

    const salary = Number(document.getElementById("salary").value);
    const rate = Number(document.getElementById("rate").value) || 0.0240;

    if(!salary || salary <= 0){
        alert("กรุณากรอกเงินเดือนสุทธิ (KRW) ก่อนบันทึก");
        return;
    }

    const now = new Date();
    const month = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    const monthLabel = now.toLocaleDateString("th-TH", { month:"long", year:"numeric" });

    const records = getSalaryRecords();
    if(records.some(item => item.month === month)){
        const msg = "มีเดือนนี้ (" + monthLabel + ") อยู่แล้ว ถ้าต้องการบันทึกใหม่ให้ลบรายการเดือนนี้ในประวัติก่อน";
        setStatus("⚠️ " + msg, "warn");
        alert(msg);
        return;
    }

    records.push({ month, salary, rate });
    localStorage.setItem("salaryRecords", JSON.stringify(records));
    kfpClearDeleted("salaryRecords");
    kfpPersistNow();

    document.getElementById("filterYear").value = "latest";

    updateAnalytics();
    loadSalaryRecords();
    updateGoalTracker();

    setStatus("✅ บันทึก " + monthLabel + " " + formatNumber(salary) + " KRW แล้ว", "ok");
}

function getSalaryRecords(){
    return JSON.parse(
        localStorage.getItem("salaryRecords")
        || "[]"
    );
}


// Called by auth.js after Cloud data is loaded into LocalStorage.
// Re-render the existing finance UI without changing the underlying finance logic.
window.__kfpRefreshFromCloud = function(){
    try {
        loadData();
        const goalValue = localStorage.getItem("goal");
        const currentSavingValue = localStorage.getItem("currentSaving");
        if(goalValue !== null) document.getElementById("goal").value = goalValue;
        if(currentSavingValue !== null) document.getElementById("currentSaving").value = currentSavingValue;
        loadSalaryRecords();
        updateAnalytics();
        updateGoalTracker();
        loadContract();
        updateSalaryPreview();
        convertCurrency();
        renderQuickConvert();
        calculateRemit();
        if(typeof renderPieChart === "function") renderPieChart();
    } catch (e) {
        console.warn("KFP cloud UI refresh:", e);
    }
};

window.onload = function(){

    loadData();

loadSalaryRecords();

updateAnalytics();

updateGoalTracker();

loadContract();
updateSalaryPreview();

    document
    .getElementById("salary")
    .addEventListener(
        "input",
        updateSalaryPreview
    );

    document
    .getElementById("rate")
    .addEventListener(
        "input",
        function(){
            updateSalaryPreview();
            convertCurrency();
            renderQuickConvert();
        }
    );

    document
    .getElementById("convertAmount")
    ?.addEventListener(
        "input",
        convertCurrency
    );

    document
    .getElementById("convertType")
    ?.addEventListener(
        "change",
        convertCurrency
    );

    kfpAutoUpdateRateIfStale();

};

// อัปเดตเรตอัตโนมัติเมื่อไม่เคยอัปเดต หรือเรตเก่าเกิน 24 ชั่วโมง
// (แยกเป็นฟังก์ชันเพื่อให้ทำงานได้แม้ส่วนอื่นของ onload เช่น กราฟ จะ error ก่อนถึงบรรทัดนี้)
function kfpAutoUpdateRateIfStale(){

    if(window.__kfpRateAutoChecked) return;
    window.__kfpRateAutoChecked = true;

    const lastUpdate =
    localStorage.getItem(
        "rateUpdatedAt"
    );

    if(!lastUpdate){

        updateExchangeRate();

    }
    else{

        const diffHours =
            (
                Date.now() -
                new Date(lastUpdate)
            ) /
            (1000 * 60 * 60);

        if(!Number.isFinite(diffHours) || diffHours >= 24){

            updateExchangeRate();
            renderQuickConvert();

        }

    }
}

// สำรอง: ถ้า window.onload หยุดกลางทางเพราะ error ก็ยังเช็กเรตให้
window.addEventListener("load", function(){
    try{ kfpAutoUpdateRateIfStale(); }catch(_){}
});


/* ===== พอร์ตทอง (มูลค่าปัจจุบัน) ในการ์ดสถิติ ช่อง ออมทอง 15% ===== */
function kfpRenderGoldPortfolio(){
    const box = document.getElementById("goldPortfolioInfo");
    if(!box) return;
    let snap = null;
    try{ snap = JSON.parse(localStorage.getItem("kfp_gold_portfolio_snapshot_v1") || "null"); }catch(_){}
    if(!snap || !(Number(snap.value) > 0)){ box.hidden = true; return; }

    const baht = n => "฿" + new Intl.NumberFormat("th-TH", {minimumFractionDigits:2, maximumFractionDigits:2}).format(n);
    const pl = Number(snap.pl) || 0, pct = Number(snap.pct) || 0;

    document.getElementById("goldPortfolioValue").textContent = baht(Number(snap.value));
    const plEl = document.getElementById("goldPortfolioPL");
    plEl.textContent = "P/L " + (pl >= 0 ? "+" : "-") + baht(Math.abs(pl)) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%)";
    plEl.className = "sp-pl " + (pl > 0 ? "up" : pl < 0 ? "down" : "");
    document.getElementById("goldPortfolioTime").textContent = snap.ts
        ? "อัปเดตจากหน้าพอร์ตทอง " + new Date(snap.ts).toLocaleString("th-TH", {dateStyle:"short", timeStyle:"short"})
        : "";
    box.hidden = false;
}
kfpRenderGoldPortfolio();
window.addEventListener("pageshow", kfpRenderGoldPortfolio);
window.addEventListener("storage", kfpRenderGoldPortfolio);
document.addEventListener("visibilitychange", () => { if(!document.hidden) kfpRenderGoldPortfolio(); });
