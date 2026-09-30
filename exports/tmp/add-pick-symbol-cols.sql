-- P36-C：strategy_pick 增「具体票 + 次日回填」列。
-- 走 db execute 而不是 db push：db push 会顺手删掉运行时裸建的 factor_cache（5371 行历史，删了补不回来）。
-- SQLite 的 ALTER TABLE ADD COLUMN 对已存在列会报错，故逐列判重后再加（可重复执行）。
ALTER TABLE strategy_pick ADD COLUMN symbols TEXT;
ALTER TABLE strategy_pick ADD COLUMN nextDaySymWin REAL;
ALTER TABLE strategy_pick ADD COLUMN nextDaySymUp INTEGER;
ALTER TABLE strategy_pick ADD COLUMN nextDaySymCount INTEGER;
ALTER TABLE strategy_pick ADD COLUMN nextDaySymSkip INTEGER;
ALTER TABLE strategy_pick ADD COLUMN nextDayBenchNet REAL;
ALTER TABLE strategy_pick ADD COLUMN nextDayBasis TEXT;
ALTER TABLE strategy_pick ADD COLUMN symBackfilledAt DATETIME;
