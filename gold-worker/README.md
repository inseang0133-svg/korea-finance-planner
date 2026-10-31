# Gold recorder (Cloudflare Worker + D1, ฟรี)

บันทึกราคาทองรายนาที (close/high/low) ตลอด 24 ชม. ให้เว็บดึงไปรวมกับกราฟ

## วิธีที่ 1: ผ่านหน้าเว็บ Cloudflare (ไม่ต้องลงโปรแกรม)
1. Cloudflare Dashboard → **Storage & Databases → D1 → Create database** ชื่อ `gold-ticks`
2. เข้า database → **Console** → วางเนื้อหาไฟล์ `schema.sql` → Execute
3. **Workers & Pages → Create → Worker** ตั้งชื่อ `gold-recorder` → Deploy → **Edit code** → วางโค้ด `worker.js` ทั้งหมด → Deploy
4. Worker → **Settings → Bindings → Add → D1 database** ตั้ง Variable name = `DB` เลือก `gold-ticks`
5. Worker → **Settings → Triggers → Cron Triggers → Add** ใส่ `* * * * *`
6. เปิด `https://<ชื่อ-worker>.<account>.workers.dev/health` ควรเห็น `{"ok":true,...}` และ `rows` เพิ่มขึ้นทุกนาที
7. ใน `gold.js` ใส่ URL เดียวกันที่ `TICKS_URL`, `MARKET_PROXY_URL`, `GOLD2GO_WORKER_URL` (ใช้ URL เดียวได้ทั้ง 3 ตัว)

## วิธีที่ 2: wrangler (ต้องมี Node.js)
```
cd gold-worker
npx wrangler login
npx wrangler d1 create gold-ticks        # คัดลอก database_id ไปใส่ใน wrangler.toml
npx wrangler d1 execute gold-ticks --remote --file=schema.sql
npx wrangler deploy
```
