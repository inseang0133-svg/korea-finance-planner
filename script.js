let salaryChart = null;
let savingChart = null;
let pieChart = null;
function formatNumber(num){
    return new Intl.NumberFormat().format(num);
}

// Hana Bank Cash Sell remit-rate controller.
// Auto calls are throttled to once every 5 minutes per browser origin.
// Manual input is never overwritten until the user presses Update.
const REMIT_RATE_DEFAULT = 42.75;
const REMIT_RATE_MIN_INTERVAL_MS = 5 * 60 * 1000;
const REMIT_RATE_FORCE_MIN_INTERVAL_MS = 60 * 1000;
const HANA_FX_ENDPOINT = "https://fx.kebhana.com/FER1101M.web";
const REMIT_RATE_KEY = "remitRate";
const REMIT_RATE_UPDATED_KEY = "remitRateUpdatedAt";
const REMIT_RATE_MODE_KEY = "remitRateMode";
const REMIT_RATE_LAST_ATTEMPT_KEY = "remitRateLastAttemptAt";
let remitRateFetchInFlight = false;

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
    const thb = parseFloat(document.getElementById("receiveTHB").value);
    const transferFee = parseFloat(document.getElementById("transferFee").value) || 0;
    const receiveFeeTHB = 60;
    const remitRate = parseFloat(document.getElementById("remitRate").value);

    if(!thb || !remitRate || remitRate <= 0){
        document.getElementById("remitResult").innerHTML = "-";
        return;
    }

    const receiveFee = Math.round(receiveFeeTHB * remitRate);
    const receiveFeeInput = document.getElementById("receiveFee");
    if(receiveFeeInput) receiveFeeInput.value = receiveFee;

    const krwForRecipient = thb * remitRate;
    const totalFee = transferFee + receiveFee;
    const krwNeeded = krwForRecipient + totalFee;

    document.getElementById("remitResult").innerHTML = `
        <div><strong>ค่าธรรมเนียมรวม: ${Math.round(totalFee).toLocaleString()} KRW</strong></div>
        <br>
        <div style="font-size:1.25em;"><strong>ต้องโอนประมาณ ${Math.round(krwNeeded).toLocaleString()} KRW</strong></div>
    `;
}

function setRemitRateStatus(message, type = "info"){
    const el = document.getElementById("remitRateStatus");
    if(!el) return;
    el.className = `remit-rate-status ${type}`;
    el.innerText = message;
}

function renderRemitRateState(){
    const input = document.getElementById("remitRate");
    if(!input) return;
    const saved = parseFloat(localStorage.getItem(REMIT_RATE_KEY));
    const rate = Number.isFinite(saved) && saved > 0 ? saved : REMIT_RATE_DEFAULT;
    input.value = rate.toFixed(2);

    const mode = localStorage.getItem(REMIT_RATE_MODE_KEY) || "auto";
    const updatedAt = localStorage.getItem(REMIT_RATE_UPDATED_KEY);
    if(mode === "manual"){
        setRemitRateStatus(`✍️ Manual • ${rate.toFixed(2)} KRW/THB • API จะไม่เขียนทับ`, "manual");
    } else if(updatedAt){
        setRemitRateStatus(`🟢 Auto • Hana Cash Sell • อัปเดตล่าสุด ${new Date(updatedAt).toLocaleString("th-TH")}`, "success");
    } else {
        setRemitRateStatus(`🟡 Auto • Hana Cash Sell • ยังไม่มีเวลาการอัปเดต`, "info");
    }
    calculateRemit();
}

function handleRemitRateInput(){
    const input = document.getElementById("remitRate");
    const rate = parseFloat(input && input.value);
    if(!Number.isFinite(rate) || rate <= 0) return;
    localStorage.setItem(REMIT_RATE_KEY, rate.toFixed(2));
    localStorage.setItem(REMIT_RATE_MODE_KEY, "manual");
    setRemitRateStatus(`✍️ Manual • ${rate.toFixed(2)} KRW/THB • API จะไม่เขียนทับ`, "manual");
    calculateRemit();
}

function extractHanaCashSell(text){
    try {
        const data = JSON.parse(text);
        const rows = Array.isArray(data) ? data : (data.data?.LIST || data.LIST || []);
        const row = rows.find(x => String(x.ISOCODE || x.code || x.currency || "").toUpperCase() === "THB");
        if(row){
            const value = Number(row.CASHSELL ?? row.cashSell ?? row.cash_sell);
            if(Number.isFinite(value) && value > 0) return value;
        }
        if(data.rates?.THB){
            const value = Number(data.rates.THB.cashSell);
            if(Number.isFinite(value) && value > 0) return value;
        }
    } catch (_) {}

    const cleaned = String(text).replace(/\s+/g, " ");
    const thbPos = cleaned.search(/(?:THB|태국|泰國)/i);
    const area = thbPos >= 0 ? cleaned.slice(Math.max(0, thbPos - 120), thbPos + 900) : cleaned;
    const patterns = [
        /(?:현찰\s*파실때|cash\s*sell)[^0-9]{0,120}([0-9]{1,3}(?:[,.][0-9]{2,4})?)/i,
        /CASHSELL[^0-9]{0,80}([0-9]+(?:\.[0-9]+)?)/i,
        /(?:현찰파실때|cashSell)[^0-9]{0,80}([0-9]+(?:\.[0-9]+)?)/i
    ];
    for(const re of patterns){
        const m = area.match(re);
        if(m){
            const value = Number(String(m[1]).replace(/,/g, ""));
            if(Number.isFinite(value) && value > 0) return value;
        }
    }
    return null;
}

async function fetchHanaCashSell(){
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(`${HANA_FX_ENDPOINT}?_=${Date.now()}`, {
            method: "GET", cache: "no-store", credentials: "omit", signal: controller.signal
        });
        if(!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const rate = extractHanaCashSell(text);
        if(!rate) throw new Error("THB Cash Sell not found");
        return rate;
    } finally { clearTimeout(timeout); }
}

async function updateRemitRate(force = false){
    if(remitRateFetchInFlight) return false;
    const now = Date.now();
    const lastAttempt = Number(localStorage.getItem(REMIT_RATE_LAST_ATTEMPT_KEY) || 0);
    const minInterval = force ? REMIT_RATE_FORCE_MIN_INTERVAL_MS : REMIT_RATE_MIN_INTERVAL_MS;

    if(lastAttempt && now - lastAttempt < minInterval){
        if(!force) return false;
        const remain = Math.ceil((minInterval - (now - lastAttempt)) / 1000);
        setRemitRateStatus(`🕒 ป้องกันการเรียก API ถี่เกินไป • ลองใหม่ใน ${remain} วินาที`, "info");
        return false;
    }
    if(!force && (localStorage.getItem(REMIT_RATE_MODE_KEY) || "auto") === "manual") return false;

    remitRateFetchInFlight = true;
    localStorage.setItem(REMIT_RATE_LAST_ATTEMPT_KEY, String(now));
    setRemitRateStatus("🔄 กำลังดึง Hana Cash Sell...", "loading");
    try {
        const rate = await fetchHanaCashSell();
        const updatedAt = new Date().toISOString();
        document.getElementById("remitRate").value = rate.toFixed(2);
        localStorage.setItem(REMIT_RATE_KEY, rate.toFixed(2));
        localStorage.setItem(REMIT_RATE_UPDATED_KEY, updatedAt);
        localStorage.setItem(REMIT_RATE_MODE_KEY, "auto");
        setRemitRateStatus(`🟢 Auto • Hana Cash Sell • ${rate.toFixed(2)} KRW/THB • อัปเดตล่าสุด ${new Date(updatedAt).toLocaleString("th-TH")}`, "success");
        calculateRemit();
        return true;
    } catch(error){
        console.warn("Hana Cash Sell fetch failed:", error);
        const current = parseFloat(document.getElementById("remitRate").value) || REMIT_RATE_DEFAULT;
        setRemitRateStatus(`🟠 API ไม่พร้อม • ใช้ค่า ${current.toFixed(2)} ต่อไป • แก้เองได้`, "warning");
        calculateRemit();
        return false;
    } finally { remitRateFetchInFlight = false; }
}

function initRemitRate(){
    if(!document.getElementById("remitRate")) return;
    if(!localStorage.getItem(REMIT_RATE_KEY)) localStorage.setItem(REMIT_RATE_KEY, REMIT_RATE_DEFAULT.toFixed(2));
    if(!localStorage.getItem(REMIT_RATE_MODE_KEY)) localStorage.setItem(REMIT_RATE_MODE_KEY, "auto");
    renderRemitRateState();

    const mode = localStorage.getItem(REMIT_RATE_MODE_KEY) || "auto";
    const lastAttempt = Number(localStorage.getItem(REMIT_RATE_LAST_ATTEMPT_KEY) || 0);
    if(mode === "auto" && (!lastAttempt || Date.now() - lastAttempt >= REMIT_RATE_MIN_INTERVAL_MS)) updateRemitRate(false);

    setInterval(() => {
        if((localStorage.getItem(REMIT_RATE_MODE_KEY) || "auto") === "auto") updateRemitRate(false);
    }, REMIT_RATE_MIN_INTERVAL_MS);
}

function renderPieChart(){
    const ctx = document.getElementById("pieChart");
    if(!ctx) return;

    if(pieChart){
        pieChart.destroy();
    }

    // ดึงค่าคำนวณล่าสุดเพื่อนำมาใส่ในกราฟ
    const salary = Number(document.getElementById("salary").value) || 0;
    const rate = Number(document.getElementById("rate").value) || 0;

    // คำนวณยอดเงินแต่ละส่วน (ตามสัดส่วน % ของคุณ)
    const dataValues = [
        { label: "💰 เงินเก็บ 45%", krw: salary * 0.45 },
        { label: "🥇 ออมทอง 15%", krw: salary * 0.15 },
        { label: "🏠 ส่งบ้าน 25%", krw: salary * 0.25 },
        { label: "🛒 ใช้ส่วนตัว 10%", krw: salary * 0.10 },
        { label: "✈️ เที่ยว 5%", krw: salary * 0.05 }
    ];

    // เปิดใช้งานปลั๊กอินแสดงตัวเลขบนกราฟ
    Chart.register(ChartDataLabels);

    pieChart = new Chart(ctx, {
        type: "pie",
        data: {
            labels: dataValues.map(item => item.label.split(" ")[1]), // ดึงชื่อเช่น "เงินเก็บ", "ออมทอง"
            datasets: [{
                data: dataValues.map(item => item.krw),
                backgroundColor: [
                    '#36a2eb', // เงินเก็บ (น้ำเงิน)
                    '#ff6384', // ออมทอง (ชมพู)
                    '#ff9f40', // ส่งบ้าน (ส้ม)
                    '#ffcd56', // ใช้ส่วนตัว (เหลือง)
                    '#4bc0c0'  // เที่ยว (เขียวมิ้นต์)
                ]
            }]
        },
        options: {
            responsive: true,
            plugins: {
                // 1. จัดการข้อความอธิบายสี (ด้านบนกราฟ)
                legend: {
                    position: 'top',
                    labels: {
                        color: '#fff',
                        font: { family: 'Arial, sans-serif' }
                    }
                },
                // 2. ปรับแต่ง Tooltip ตอนเอาเมาส์ชี้/กด (ให้แสดงครบ 3 บรรทัดตามที่คุณต้องการ)
                tooltip: {
                    callbacks: {
                        title: function(context) {
                            // แสดงหัวข้อเช่น "💰 เงินเก็บ 45%"
                            return dataValues[context[0].dataIndex].label;
                        },
                        label: function(context) {
                            const index = context.dataIndex;
                            const krwAmt = dataValues[index].krw;
                            const thbAmt = krwAmt * rate;
                            
                            // ส่งกลับมาเป็นอาร์เรย์เพื่อให้ Chart.js ขึ้นบรรทัดใหม่ให้ใน Tooltip
                            return [
                                `${formatNumber(krwAmt.toFixed(1))} KRW`,
                                `≈ ${formatNumber(thbAmt.toFixed(0))} THB`
                            ];
                        }
                    }
                },
                // 3. แสดงยอดเงินบาทไทยค้างไว้บนตัวกราฟตลอดเวลา (Data Labels)
                datalabels: {
                    color: '#181818',
                    font: {
                        weight: 'bold',
                        size: 11
                    },
                    formatter: function(value, context) {
                        const thbAmt = value * rate;
                        // แสดงตัวเลขเงินบาท เช่น "22,378 THB" บนชิ้นเค้กเลย
                        return formatNumber(thbAmt.toFixed(0)) + ' THB';
                    },
                    // ป้องกันไม่ให้ตัวเลขทับกันถ้าชิ้นเค้กเล็กเกินไป
                    display: function(context) {
                        return context.dataset.data[context.dataIndex] > 0;
                    }
                }
            }
        }
    });
}

function loadContract(){

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

    const start =
        new Date(savedDate);

    const end =
        new Date(start);

    // 4 ปี 10 เดือน
    end.setMonth(
        end.getMonth() + 58
    );

    const remainDays =
        Math.ceil(
            (
                end -
                new Date()
            ) /
            86400000
        );

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
            เหลืออีก
            <strong>
            ${remainDays.toLocaleString()}
            วัน
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

    document.getElementById("filterYear").value = "latest"; 
    
    

updateAnalytics();

loadSalaryRecords();

updateGoalTracker();
    
    document.getElementById("salaryRecord").value = "";
}

function getSalaryRecords(){
    return JSON.parse(
        localStorage.getItem("salaryRecords")
        || "[]"
    );
}

window.onload = function(){

    loadData();

loadSalaryRecords();

updateAnalytics();

updateGoalTracker();

loadContract();
updateSalaryPreview();
    initRemitRate();

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
        updateSalaryPreview
    );

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

    if(diffHours >= 24){

        updateExchangeRate();
        renderQuickConvert();

    }

}

};
