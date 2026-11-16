CREATE TABLE IF NOT EXISTS ticks (
  b INTEGER PRIMARY KEY,  -- เวลาต้นนาที (ms, UTC)
  c REAL NOT NULL,        -- ราคาปิดของนาที
  h REAL NOT NULL,        -- สูงสุดของนาที
  l REAL NOT NULL         -- ต่ำสุดของนาที
);

-- ราคาสมาคมค้าทองคำล่าสุด (1 แถว) — Worker สร้างตารางนี้ให้อัตโนมัติ ถ้ายังไม่มี
CREATE TABLE IF NOT EXISTS thai_gold (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,          -- JSON {barBuy, barSell, jewelryBuy, jewelrySell, updatedAt, source}
  fetched_at INTEGER NOT NULL  -- ms
);
