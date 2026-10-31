CREATE TABLE IF NOT EXISTS ticks (
  b INTEGER PRIMARY KEY,  -- เวลาต้นนาที (ms, UTC)
  c REAL NOT NULL,        -- ราคาปิดของนาที
  h REAL NOT NULL,        -- สูงสุดของนาที
  l REAL NOT NULL         -- ต่ำสุดของนาที
);
