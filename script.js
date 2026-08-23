// Separate storage domains: monthly salary history, exchange-rate settings, and Korea contract.
const SALARY_RECORDS_KEY = "kfp_salary_records_v2";
const EXCHANGE_RATE_KEY = "kfp_exchange_rate_v1";
const EXCHANGE_RATE_UPDATED_KEY = "kfp_exchange_rate_updated_v1";
const CONTRACT_KEY = "kfp_contract_v1";
const FINANCE_SYNC_REV_KEY = "kfp_sync_revision_v1";

// Persist finance changes immediately so the PWA backup cannot resurrect deleted data.
function persistFinanceNow(){
    try {
        if (typeof window.__kfpPwaPersist === "function") window.__kfpPwaPersist();
    } catch (_) {}
}

function touchFinanceSyncRevision(){
    try {
        const current = Number(localStorage.getItem(FINANCE_SYNC_REV_KEY)) || 0;
        const next = Math.max(Date.now(), current + 1);
        localStorage.setItem(FINANCE_SYNC_REV_KEY, String(next));
    } catch (_) {}
    persistFinanceNow();
}

function markFinanceDeleted(key){
    try {
        const tombstones = JSON.parse(localStorage.getItem("kfp_deleted_keys_v1") || "{}");
        tombstones[key] = Date.now();
        localStorage.setItem("kfp_deleted_keys_v1", JSON.stringify(tombstones));
    } catch (_) {}
}

function clearFinanceDeletedMark(key){
    try {
        const tombstones = JSON.parse(localStorage.getItem("kfp_deleted_keys_v1") || "{}");
        if (Object.prototype.hasOwnProperty.call(tombstones, key)) {
            delete tombstones[key];
            localStorage.setItem("kfp_deleted_keys_v1", JSON.stringify(tombstones));
        }
    } catch (_) {}
}

function migrateFinanceStorage() {
    try {
        const migrations = [
            ["salaryRecords", SALARY_RECORDS_KEY],
            ["rate", EXCHANGE_RATE_KEY],
            ["rateUpdatedAt", EXCHANGE_RATE_UPDATED_KEY],
            ["contractStartDate", CONTRACT_KEY]
        ];
        for (const [oldKey, newKey] of migrations) {
            const oldValue = localStorage.getItem(oldKey);
            const newValue = localStorage.getItem(newKey);
            if (newValue === null && oldValue !== null) localStorage.setItem(newKey, oldValue);
            if (oldValue !== null) localStorage.removeItem(oldKey);
        }
    } catch (_) {}
}

migrateFinanceStorage();
persistFinanceNow();

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
        EXCHANGE_RATE_KEY,
        document.getElementById("rate").value
    );
    touchFinanceSyncRevision();
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
        localStorage.getItem(EXCHANGE_RATE_KEY);

    if(salary){
        document.getElementById("salary").value =
            salary;
    }

    if(rate){
        document.getElementById("rate").value =
            rate;
    }
    const updatedAt =
    localStorage.getItem(EXCHANGE_RATE_UPDATED_KEY);

if(updatedAt){

    document.getElementById(
        "exchangeStatus"
    ).innerText =
        `อัปเดตล่าสุด ${new Date(updatedAt)
        .toLocaleString("th-TH")}`;

}
}

function refreshFinanceRealtime(){
    // These outputs depend only on the current salary/rate inputs.
    // They must never depend on whether salary history has any records.
    updateSalaryPreview();
    if (document.getElementById("convertAmount")?.value) convertCurrency();
    if (typeof renderQuickConvert === "function") renderQuickConvert();
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
    const records = JSON.parse(localStorage.getItem(SALARY_RECORDS_KEY) || "[]");
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
    SALARY_RECORDS_KEY,
    JSON.stringify(records)
    );
    if (records.length === 0) markFinanceDeleted(SALARY_RECORDS_KEY);
    else clearFinanceDeletedMark(SALARY_RECORDS_KEY);
    touchFinanceSyncRevision();

    updateAnalytics();

loadSalaryRecords();
}



function updateAnalytics(){
    const records =
        getSalaryRecords();
    

    if(records.length === 0){

        document.getElementById(
            "avgSalary"
        ).innerText = "0 KRW";

        document.getElementById(
            "avgSaving"
        ).innerText = "0 KRW";

        document.getElementById(
            "monthsToGoal"
        ).innerText = "-";

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
    renderChart();
    renderSavingChart();

}

function renderChart(){
    const rate =
    Number(
        document.getElementById("rate").value
    );

    const records =
    getSalaryRecords();

const labels =
    records.map(x => x.month);

const data =
    records.map(x => x.salary);

    const ctx =
        document
        .getElementById(
            "salaryChart"
        );

    if(salaryChart){

        salaryChart.destroy();

    }

    salaryChart =
        new Chart(ctx,{

            type:"bar",

            data:{

                labels,

                datasets:[{

                    label:"รายได้ (KRW)",

                    data

                }]

            },

            options:{
    responsive:true,

    plugins:{
        tooltip:{
            callbacks:{
                label:function(context){

                    const krw =
                        context.raw;

                    const thb =
                        krw * rate;

                    return [
                        `รายได้ (KRW): ${formatNumber(krw)}`,
                        `≈ ${formatNumber(
                            Math.round(thb)
                        )} THB`
                    ];
                }
            }
        }
    }
}

        });

}

function renderSavingChart(){
    const rate =
    Number(
        document.getElementById("rate").value
    );
    const records =
    getSalaryRecords();

    if(records.length === 0){

    if(savingChart){
        savingChart.destroy();
        savingChart = null;
    }

    return;
}

    const labels = [];
    const savingsData = [];

    let totalSaving = 0;

    const sortedRecords =
        [...records]
        .sort((a,b)=>
            a.month.localeCompare(b.month)
        );
    sortedRecords.forEach(item=>{

        labels.push(item.month);

        totalSaving += item.salary * 0.45;

        savingsData.push(
            Math.round(totalSaving)
        );

    });

    const ctx =
        document.getElementById(
            "savingChart"
        );

    if(savingChart){

        savingChart.destroy();

    }

    savingChart =
        new Chart(ctx,{

            type:"line",

            data:{

                labels,

                datasets:[{

                    label:"เงินเก็บสะสม (KRW)",

                    data:savingsData,

                    tension:0.3,

                    fill:false

                }]

            },

            options:{
    responsive:true,

    plugins:{
        tooltip:{
            callbacks:{
                label:function(context){

                    const krw =
                        context.raw;

                    const thb =
                        krw * rate;

                    return [
                        `เงินเก็บสะสม (KRW): ${formatNumber(krw)}`,
                        `≈ ${formatNumber(
                            Math.round(thb)
                        )} THB`
                    ];
                }
            }
        }
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

        const data =
            await response.json();

        const thbRate =
            data.rates.THB;

        document.getElementById(
            "rate"
        ).value =
            thbRate.toFixed(4);

        localStorage.setItem(
            EXCHANGE_RATE_KEY,
            thbRate.toFixed(4)
        );

        const now = new Date();

        localStorage.setItem(
            EXCHANGE_RATE_UPDATED_KEY,
            now.toISOString()
        );

        status.innerText =
            `อัปเดตล่าสุด ${now.toLocaleString("th-TH")}
            | 1 KRW = ${thbRate.toFixed(4)} THB`;

        // Refresh only finance calculations. Salary history and Korea contract are independent.
        refreshFinanceRealtime();
        touchFinanceSyncRevision();

    }
    catch(error){

        console.error(error);

        status.innerText =
            "ไม่สามารถดึงค่าเงินได้";

    }

}

function exportExcel() {
    const records = JSON.parse(localStorage.getItem(SALARY_RECORDS_KEY) || "[]");
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

    const resultEl = document.getElementById("convertResult");
    if (!resultEl) return;

    if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(rate) || rate <= 0) {
        resultEl.innerHTML = "-";
        return;
    }

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
    const select = document.getElementById("convertType");
    if (!select) return;
    select.value = select.value === "KRW_TO_THB" ? "THB_TO_KRW" : "KRW_TO_THB";
    convertCurrency();
}


function initFinancePage(){
    loadData();
    loadSalaryRecords();
    updateAnalytics();
    updateGoalTracker();
    loadContract();
    updateSalaryPreview();

    const salaryEl = document.getElementById("salary");
    const rateEl = document.getElementById("rate");
    const convertAmountEl = document.getElementById("convertAmount");
    const convertTypeEl = document.getElementById("convertType");

    salaryEl?.addEventListener("input", updateSalaryPreview);
    rateEl?.addEventListener("input", () => {
        localStorage.setItem(EXCHANGE_RATE_KEY, rateEl.value);
        clearFinanceDeletedMark(EXCHANGE_RATE_KEY);
        touchFinanceSyncRevision();
        refreshFinanceRealtime();
    });
    convertAmountEl?.addEventListener("input", convertCurrency);
    convertTypeEl?.addEventListener("change", convertCurrency);

    // Run once immediately. No salary-history record is required.
    convertCurrency();
    refreshFinanceRealtime();

    const lastUpdate = localStorage.getItem(EXCHANGE_RATE_UPDATED_KEY);
    if (!lastUpdate) {
        updateExchangeRate();
    } else {
        const diffHours = (Date.now() - new Date(lastUpdate)) / (1000 * 60 * 60);
        if (diffHours >= 24) updateExchangeRate();
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFinancePage, { once:true });
} else {
    initFinancePage();
}
