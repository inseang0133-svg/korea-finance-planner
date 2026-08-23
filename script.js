let salaryChart = null;
let savingChart = null;
let pieChart = null;
function formatNumber(num){
    return new Intl.NumberFormat().format(num);
}

// Hana Bank Cash Sell remit-rate controller.
// Modes:
//   default = ยังไม่เคยดึง Hana สำเร็จ ใช้ค่าเริ่มต้น 42.75
//   auto    = ดึงจาก Hana สำเร็จล่าสุด
//   cached  = Hana ดึงรอบล่าสุดไม่สำเร็จ จึงใช้เรต Auto ที่เคยดึงสำเร็จ
//   manual  = ผู้ใช้กรอกเอง และ Auto จะไม่เขียนทับจนกว่าจะกด "อัปเดตเรต"
//
// ใช้ <script src="..."> แทน fetch เพราะ endpoint ของ Hana เป็น JavaScript
// ที่ประกาศตัวแปร global "exView" และวิธีนี้ไม่ติด CORS แบบ fetch ตรง ๆ
const REMIT_RATE_DEFAULT = 42.75;
const REMIT_RATE_MIN_INTERVAL_MS = 5 * 60 * 1000;
const REMIT_RATE_FORCE_MIN_INTERVAL_MS = 60 * 1000;
const HANA_FX_ENDPOINT = "https://fx.kebhana.com/FER1101M.web";

const REMIT_RATE_KEY = "remitRate";
const REMIT_RATE_UPDATED_KEY = "remitRateUpdatedAt";
const REMIT_RATE_MODE_KEY = "remitRateMode";
const REMIT_RATE_LAST_ATTEMPT_KEY = "remitRateLastAttemptAt";
const REMIT_RATE_SOURCE_DATE_KEY = "remitRateSourceDate";
const REMIT_RATE_LAST_ERROR_KEY = "remitRateLastError";

let remitRateFetchInFlight = false;

function saveRemitRate(rate, mode, updatedAt = "", sourceDate = ""){
    localStorage.setItem(REMIT_RATE_KEY, Number(rate).toFixed(2));
    localStorage.setItem(REMIT_RATE_MODE_KEY, mode);

    if(updatedAt){
        localStorage.setItem(REMIT_RATE_UPDATED_KEY, updatedAt);
    }

    if(sourceDate){
        localStorage.setItem(REMIT_RATE_SOURCE_DATE_KEY, sourceDate);
    }

    if(mode !== "default"){
        localStorage.removeItem(REMIT_RATE_LAST_ERROR_KEY);
    }
}

function formatRemitDate(iso){
    if(!iso) return "-";
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
        ? "-"
        : d.toLocaleString("th-TH");
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
    const hasSavedRate = Number.isFinite(saved) && saved > 0;
    const mode = localStorage.getItem(REMIT_RATE_MODE_KEY) || (hasSavedRate ? "default" : "default");

    const rate = hasSavedRate ? saved : REMIT_RATE_DEFAULT;
    const updatedAt = localStorage.getItem(REMIT_RATE_UPDATED_KEY);
    const sourceDate = localStorage.getItem(REMIT_RATE_SOURCE_DATE_KEY);

    input.value = rate.toFixed(2);

    if(mode === "manual"){
        setRemitRateStatus(
            `✍️ Manual • ${rate.toFixed(2)} KRW/THB • API จะไม่เขียนทับ`,
            "manual"
        );
    }
    else if(mode === "cached" && updatedAt){
        const sourceText = sourceDate ? ` • Hana ประกาศ ${sourceDate}` : "";
        setRemitRateStatus(
            `🟠 Cached • ${rate.toFixed(2)} KRW/THB • Hana ดึงล่าสุด ${formatRemitDate(updatedAt)}${sourceText} • รอบล่าสุดดึงไม่สำเร็จ`,
            "warning"
        );
    }
    else if(mode === "auto" && updatedAt){
        const sourceText = sourceDate ? ` • Hana ประกาศ ${sourceDate}` : "";
        setRemitRateStatus(
            `🟢 Auto • Hana Cash Sell • ${rate.toFixed(2)} KRW/THB • ดึงสำเร็จ ${formatRemitDate(updatedAt)}${sourceText}`,
            "success"
        );
    }
    else {
        setRemitRateStatus(
            `⚪ Default • ยังไม่เคยดึง Hana สำเร็จ • ใช้ค่าเริ่มต้น ${rate.toFixed(2)} KRW/THB`,
            "info"
        );
    }

    calculateRemit();
}

function handleRemitRateInput(){
    const input = document.getElementById("remitRate");
    const rate = parseFloat(input && input.value);

    if(!Number.isFinite(rate) || rate <= 0) return;

    localStorage.setItem(REMIT_RATE_KEY, rate.toFixed(2));
    localStorage.setItem(REMIT_RATE_MODE_KEY, "manual");

    setRemitRateStatus(
        `✍️ Manual • ${rate.toFixed(2)} KRW/THB • API จะไม่เขียนทับ`,
        "manual"
    );

    calculateRemit();
}

/**
 * Hana endpoint ไม่ได้ตอบ JSON API แบบ REST แต่ส่ง JavaScript:
 * var exView = { "날짜": "...", "리스트": [ ... ] }
 *
 * ดังนั้นเราโหลดเป็น <script> เพื่อให้ browser execute แล้วอ่าน window.exView
 * ซึ่งหลีกเลี่ยงปัญหา CORS ที่เกิดกับ fetch() ตรง ๆ
 */
function loadHanaExchangeScript(timeoutMs = 10000){
    return new Promise((resolve, reject) => {
        const previousExView = window.exView;

        // ล้างค่าก่อน เพื่อป้องกันการเผลออ่านข้อมูลรอบเก่า
        try {
            window.exView = undefined;
        } catch (_) {}

        const script = document.createElement("script");
        script.async = true;
        script.src = `${HANA_FX_ENDPOINT}?_=${Date.now()}`;

        let finished = false;

        const cleanup = () => {
            clearTimeout(timer);
            script.onload = null;
            script.onerror = null;
            if(script.parentNode) script.parentNode.removeChild(script);
        };

        const finishError = (error) => {
            if(finished) return;
            finished = true;

            // คืนค่าของเดิมถ้าโหลดรอบใหม่ไม่สำเร็จ
            try {
                if(previousExView !== undefined){
                    window.exView = previousExView;
                }
            } catch (_) {}

            cleanup();
            reject(error);
        };

        const timer = setTimeout(() => {
            finishError(new Error("Hana API timeout"));
        }, timeoutMs);

        script.onload = () => {
            if(finished) return;

            try {
                const data = window.exView;

                if(!data || typeof data !== "object"){
                    throw new Error("Hana exView not found");
                }

                const rows = Array.isArray(data["리스트"])
                    ? data["리스트"]
                    : [];

                const row = rows.find(item => {
                    const name = String(item?.["통화명"] || "");
                    return /\bTHB\b/i.test(name) || /태국/.test(name);
                });

                if(!row){
                    throw new Error("THB row not found");
                }

                // Hana ใช้ "현찰파실때" = Cash Sell
                // สำหรับ THB ค่าเป็น KRW ต่อ 1 THB
                const rawRate = row["현찰파실때"];
                const rate = Number(
                    String(rawRate ?? "")
                        .replace(/,/g, "")
                        .trim()
                );

                if(!Number.isFinite(rate) || rate <= 0){
                    throw new Error("Invalid THB Cash Sell");
                }

                const sourceDate = String(data["날짜"] || "").trim();

                finished = true;
                cleanup();

                resolve({
                    rate,
                    sourceDate,
                    currencyName: String(row["통화명"] || "태국 THB")
                });
            }
            catch(error){
                finishError(error);
            }
        };

        script.onerror = () => {
            finishError(new Error("Hana script load failed"));
        };

        document.head.appendChild(script);
    });
}

async function fetchHanaCashSell(){
    return await loadHanaExchangeScript(10000);
}

async function updateRemitRate(force = false){
    if(remitRateFetchInFlight) return false;

    const now = Date.now();
    const lastAttempt = Number(
        localStorage.getItem(REMIT_RATE_LAST_ATTEMPT_KEY) || 0
    );

    const minInterval = force
        ? REMIT_RATE_FORCE_MIN_INTERVAL_MS
        : REMIT_RATE_MIN_INTERVAL_MS;

    if(lastAttempt && now - lastAttempt < minInterval){
        if(!force) return false;

        const remain = Math.ceil(
            (minInterval - (now - lastAttempt)) / 1000
        );

        setRemitRateStatus(
            `🕒 ป้องกันการเรียก Hana ถี่เกินไป • ลองใหม่ใน ${remain} วินาที`,
            "info"
        );

        return false;
    }

    // ถ้าเป็น Manual การอัปเดตอัตโนมัติห้ามเขียนทับ
    // แต่การกดปุ่ม "อัปเดตเรต" (force=true) สามารถเปลี่ยนกลับเป็น Auto ได้
    const currentMode =
        localStorage.getItem(REMIT_RATE_MODE_KEY) || "default";

    if(!force && currentMode === "manual"){
        return false;
    }

    remitRateFetchInFlight = true;
    localStorage.setItem(
        REMIT_RATE_LAST_ATTEMPT_KEY,
        String(now)
    );

    const btn = document.getElementById("updateRemitRateBtn");
    if(btn){
        btn.disabled = true;
        btn.dataset.originalText = btn.innerText;
        btn.innerText = "⏳ กำลังดึง...";
    }

    setRemitRateStatus(
        "🔄 กำลังดึง Hana Cash Sell จริง...",
        "loading"
    );

    try{
        const result = await fetchHanaCashSell();
        const rate = result.rate;
        const updatedAt = new Date().toISOString();

        document.getElementById("remitRate").value =
            rate.toFixed(2);

        saveRemitRate(
            rate,
            "auto",
            updatedAt,
            result.sourceDate
        );

        setRemitRateStatus(
            `🟢 Auto • Hana Cash Sell • ${rate.toFixed(2)} KRW/THB • ดึงสำเร็จ ${formatRemitDate(updatedAt)}${result.sourceDate ? ` • Hana ประกาศ ${result.sourceDate}` : ""}`,
            "success"
        );

        calculateRemit();
        return true;
    }
    catch(error){
        console.warn("Hana Cash Sell fetch failed:", error);

        localStorage.setItem(
            REMIT_RATE_LAST_ERROR_KEY,
            String(error?.message || error)
        );

        const current = parseFloat(
            localStorage.getItem(REMIT_RATE_KEY)
        );

        const lastSuccessfulAt =
            localStorage.getItem(REMIT_RATE_UPDATED_KEY);

        const sourceDate =
            localStorage.getItem(REMIT_RATE_SOURCE_DATE_KEY);

        if(Number.isFinite(current) && current > 0 && lastSuccessfulAt){
            // เคยได้ Auto จริงมาก่อน -> ตอนนี้ใช้ค่าล่าสุดเป็น Cached
            localStorage.setItem(
                REMIT_RATE_MODE_KEY,
                "cached"
            );

            setRemitRateStatus(
                `🟠 Cached • ${current.toFixed(2)} KRW/THB • Hana ดึงล่าสุด ${formatRemitDate(lastSuccessfulAt)}${sourceDate ? ` • Hana ประกาศ ${sourceDate}` : ""} • รอบล่าสุดดึงไม่สำเร็จ`,
                "warning"
            );
        }
        else{
            // ยังไม่เคยดึง Hana สำเร็จเลย -> ใช้ Default เท่านั้น
            const fallback = REMIT_RATE_DEFAULT;

            localStorage.setItem(
                REMIT_RATE_KEY,
                fallback.toFixed(2)
            );
            localStorage.setItem(
                REMIT_RATE_MODE_KEY,
                "default"
            );

            document.getElementById("remitRate").value =
                fallback.toFixed(2);

            setRemitRateStatus(
                `⚪ Default • Hana ยังไม่เคยดึงสำเร็จ • ใช้ค่าเริ่มต้น ${fallback.toFixed(2)} KRW/THB • กดอัปเดตเรตเพื่อลองใหม่`,
                "info"
            );
        }

        calculateRemit();
        return false;
    }
    finally{
        remitRateFetchInFlight = false;

        if(btn){
            btn.disabled = false;
            btn.innerText =
                btn.dataset.originalText || "🔄 อัปเดตเรต";
        }
    }
}

function initRemitRate(){
    if(!document.getElementById("remitRate")) return;

    const saved = parseFloat(
        localStorage.getItem(REMIT_RATE_KEY)
    );

    // ถ้ายังไม่มีเรตเลย ให้เริ่มที่ Default แต่ระบุสถานะว่าเป็น Default
    if(!Number.isFinite(saved) || saved <= 0){
        localStorage.setItem(
            REMIT_RATE_KEY,
            REMIT_RATE_DEFAULT.toFixed(2)
        );
        localStorage.setItem(
            REMIT_RATE_MODE_KEY,
            "default"
        );
    }
    else if(!localStorage.getItem(REMIT_RATE_MODE_KEY)){
        // ข้อมูลเก่าจากเวอร์ชันก่อนหน้า:
        // ถ้ามีเวลาที่เคยอัปเดตสำเร็จ ให้ถือว่า Auto;
        // ถ้าไม่มี ให้ถือว่า Default ไม่ใช่ Auto
        const oldUpdatedAt =
            localStorage.getItem(REMIT_RATE_UPDATED_KEY);

        localStorage.setItem(
            REMIT_RATE_MODE_KEY,
            oldUpdatedAt ? "auto" : "default"
        );
    }

    renderRemitRateState();

    const mode =
        localStorage.getItem(REMIT_RATE_MODE_KEY) || "default";

    const lastAttempt = Number(
        localStorage.getItem(REMIT_RATE_LAST_ATTEMPT_KEY) || 0
    );

    // Auto / Cached / Default สามารถลองดึงใหม่ได้
    // Manual จะไม่เรียกเอง
    if(
        mode !== "manual" &&
        (!lastAttempt ||
            Date.now() - lastAttempt >= REMIT_RATE_MIN_INTERVAL_MS)
    ){
        updateRemitRate(false);
    }

    // เช็กทุก 5 นาที แต่ไม่แตะ Manual
    setInterval(() => {
        const currentMode =
            localStorage.getItem(REMIT_RATE_MODE_KEY) || "default";

        if(currentMode !== "manual"){
            updateRemitRate(false);
        }
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
