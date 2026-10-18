// ─────────────────────────────────────────────
// sqlite_schema.ts · 集中所有建表语句
//
// 核心 7 张表（按依赖顺序：先父表后子表）：
//   funds / nav_daily / orders / lots / cash_ledger / fund_status / quota_usage
// 另含业务扩展表（资讯 / 情报 / 快照 / 决策 / 定投 / 预警 / 全球行情 等）。
// 起购线 min_purchase：每只基金不同，源查不到 → 保留 DB 旧值（不是「不限」）。
// ─────────────────────────────────────────────

/** 7 张表的 CREATE TABLE 语句（按依赖顺序：先父表后子表） */
export const SCHEMA_SQL: string[] = [
  // ── 1. funds：候选基金池（含起购线 min_purchase） ──
  `
  CREATE TABLE IF NOT EXISTS funds (
    fund_code TEXT PRIMARY KEY,
    fund_name TEXT NOT NULL,
    category TEXT,
    purchase_fee_rate REAL,
    min_purchase REAL DEFAULT 1.0,    -- 支付宝多数 1 元起，但各基金不同
    is_qdii INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    added_at TEXT,
    note TEXT
  );
  `,
  // ── 2. nav_daily：日净值（只存单位净值 nav，不存累计） ──
  `
  CREATE TABLE IF NOT EXISTS nav_daily (
    fund_code TEXT NOT NULL,
    nav_date TEXT NOT NULL,
    nav REAL NOT NULL,
    acc_nav REAL,                     -- 累计净值（保留字段；门控计算只用 nav）
    PRIMARY KEY (fund_code, nav_date)
  );
  CREATE INDEX IF NOT EXISTS idx_nav_daily_date ON nav_daily(nav_date DESC);
  `,
  // ── 3. fund_status：申购/赎回状态（供 status.ts 三层降级） ──
  `
  CREATE TABLE IF NOT EXISTS fund_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code TEXT NOT NULL,
    status_date TEXT NOT NULL,
    purchase_status TEXT NOT NULL,
    redeem_status TEXT NOT NULL,
    purchase_limit REAL,
    limit_unknown INTEGER DEFAULT 0,
    raw_purchase TEXT,
    raw_redeem TEXT,
    note TEXT,
    source TEXT DEFAULT 'em_daily',
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fund_status_code_date ON fund_status(fund_code, status_date DESC);
  `,
  // ── 4. orders：订单（提交/确认/取消） ──
  `
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,               -- 'buy' | 'sell'
    fund_code TEXT NOT NULL,
    amount REAL NOT NULL,
    nav_date TEXT,                    -- 顺延后的净值日（交易日 15:00 前→当日 / 否则→下一交易日）
    status TEXT NOT NULL,             -- 'pending' | 'filled' | 'cancelled'
    decision_source TEXT,             -- 'human' | 'auto'
    reason TEXT,
    fee_rate REAL,
    fee_purchase REAL,
    net_amount REAL,
    confirm_date TEXT,                -- 赎回确认日（confirm 阶段补写）
    filled_nav REAL,
    filled_shares REAL,
    filled_net_amount REAL,
    expected_arrival_date TEXT,       -- 赎回到账日（仅 sell）
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_fund ON orders(fund_code);
  `,
  // ── 5. lots：份额批次 FIFO（buy confirm 时建，sell confirm 时消耗） ──
  `
  CREATE TABLE IF NOT EXISTS lots (
    lot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code TEXT NOT NULL,
    buy_order_id TEXT NOT NULL,
    buy_date TEXT NOT NULL,
    confirm_date TEXT NOT NULL,
    shares REAL NOT NULL,
    remaining_shares REAL NOT NULL,
    cost_amount REAL NOT NULL,        -- 买入时花的钱（含费）
    status TEXT DEFAULT 'active',     -- 'active' | 'exhausted'
    -- 结构隔离：真实持仓与交易盘虚拟持仓的**物理标记**（不再靠 buy_order_id 前缀约定）
    --   'real'  = OCR 导入的真实持仓（用户存量资产）
    --   'trade' = 交易盘买入的虚拟持仓（自设本金）
    source TEXT NOT NULL DEFAULT 'trade'
      CHECK(source IN ('real','trade')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lots_fund_active ON lots(fund_code, status);
  `,
  // ── 6. cash_ledger：现金账本（init / buy / redeem / refund / dividend） ──
  `
  CREATE TABLE IF NOT EXISTS cash_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,             -- 正=入账 / 负=扣款
    memo TEXT NOT NULL,
    action TEXT NOT NULL,             -- 'initial' | 'buy' | 'redeem' | 'refund' | 'dividend'
    fund_code TEXT,
    order_id TEXT,
    shares REAL DEFAULT 0,
    cost_amount REAL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cash_ledger_action ON cash_ledger(action);
  `,
  // ── 7. quota_usage：风控配额使用（限购追踪）──
  // 一个基金每天一条用 UNIQUE(fund_code, used_date) 约束代替 PRIMARY KEY
  // （SQLite 不允许一个表里同时有 INTEGER PRIMARY KEY + 复合 PRIMARY KEY）
  `
  CREATE TABLE IF NOT EXISTS quota_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code TEXT NOT NULL,
    used_date TEXT NOT NULL,
    used_amount REAL NOT NULL,
    UNIQUE (fund_code, used_date)
  );
  `,
  // ── 8. news_feed：基金公告 + 重仓股新闻 ──
  `
  CREATE TABLE IF NOT EXISTS news_feed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code TEXT NOT NULL,
    fund_name TEXT,
    kind TEXT NOT NULL,               -- 'fund_announce' | 'stock_news'
    title TEXT NOT NULL,
    content TEXT,
    source TEXT,
    pub_time TEXT,
    url TEXT,
    related_stock TEXT,
    fetched_at TEXT NOT NULL,
    UNIQUE(fund_code, kind, title, pub_time)
  );
  CREATE INDEX IF NOT EXISTS idx_news_feed_fund_time ON news_feed(fund_code, pub_time DESC);
  CREATE INDEX IF NOT EXISTS idx_news_feed_pub_time ON news_feed(pub_time DESC);
  `,
  // ── 9. market_news：广义财经 RSS ──
  `
  CREATE TABLE IF NOT EXISTS market_news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    summary TEXT,
    source TEXT,
    source_url TEXT,
    pub_time TEXT,
    fetched_at TEXT NOT NULL,
    UNIQUE(link)
  );
  CREATE INDEX IF NOT EXISTS idx_market_news_pub_time ON market_news(pub_time DESC);
  `,
  // ── 10. intel_events：自动提取的六类情报 ──
  `
  CREATE TABLE IF NOT EXISTS intel_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date TEXT NOT NULL,
    category TEXT NOT NULL,           -- policy/geo/military/conference/macro/company
    title TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL,             -- 'disclosed'（披露态，RSS 新闻≠政策落地）
    impact_boards TEXT,
    impact_dir TEXT,                  -- positive/negative/neutral
    source TEXT,
    cross_verified INTEGER DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(title, event_date)
  );
  CREATE INDEX IF NOT EXISTS idx_intel_events_date ON intel_events(event_date DESC);
  CREATE INDEX IF NOT EXISTS idx_intel_events_category ON intel_events(category);
  `,
  // ── 11. monthly_budget：每月预算配额（已无写入方，表保留兼容旧库） ──
  // monthly_budget(ym TEXT PRIMARY KEY, quota REAL)
  `
  CREATE TABLE IF NOT EXISTS monthly_budget (
    ym TEXT PRIMARY KEY,              -- 'YYYY-MM'
    quota REAL NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // ── 8. pool_meta + market_meta：抓取缓存时间戳（避免每次启动都打东财） ──
  `
  CREATE TABLE IF NOT EXISTS pool_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS market_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // ── 12. fund_holdings：基金持仓明细（来自 industry_allocation + top_holdings 接口） ──
  // 补 industry 列。行业配置行没有股票代码（stock_code NOT NULL 会把它们全挡掉），
  //       行业名无专用列可存 → 行业配置**从未落库**，分析页「持仓透视 / 风格漂移」恒为空。
  `
  CREATE TABLE IF NOT EXISTS fund_holdings (
    fund_code   TEXT    NOT NULL,
    report_date TEXT    NOT NULL,
    stock_code  TEXT    NOT NULL,
    stock_name  TEXT,
    weight      REAL,
    board_code  TEXT,
    industry    TEXT,
    source      TEXT    NOT NULL,
    fetched_at  TEXT    NOT NULL,
    PRIMARY KEY (fund_code, report_date, stock_code, source)
  );
  `,
  // ── 14. fund_code_correction_log：代码规范化内部日志（不提示用户）──
  `
  CREATE TABLE IF NOT EXISTS fund_code_correction_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_code TEXT NOT NULL,
    fixed_code TEXT NOT NULL,
    reason TEXT NOT NULL,
    logged_at TEXT NOT NULL
  );
  `,
  // ── 15. 迁移：funds 表加 is_favorite 列（关注标记）──
  // 注：不直接 ALTER，改为在 ensureTables 中通过列存在检查后选择性执行，
  // 保证幂等（已升级过的设备不会重复触发 ALTER）。
  // ── 16. decision_log：决策日志（兜底调度器 / AI 接管 / 人工，统一留痕）──
  // 用途：AI 不在线时由调度器跑离线周期（core/rules.ts runOfflineCycle），
  //       把「纪律线触发 → 建议动作」写成一条条决策记录，供「决策速览」展示。
  `
  CREATE TABLE IF NOT EXISTS decision_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,                 -- 决策时间 YYYY-MM-DD HH:MM:SS
    source TEXT NOT NULL,             -- offline_cycle | ai | human
    action TEXT NOT NULL,             -- buy | dingtou | redeem | hold
    fund_code TEXT,
    fund_name TEXT,
    reason TEXT,
    payload TEXT,                     -- 原始明细 JSON（纪律线 / 罚期）
    created_at TEXT NOT NULL
  );
  `,
  // ── 17. dingtou_plan：定投计划（每期金额 / 频率 / 周几或几号 / 启停）──
  `
  CREATE TABLE IF NOT EXISTS dingtou_plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code TEXT NOT NULL,
    fund_name TEXT,
    amount REAL NOT NULL,             -- 每期定投金额（元）
    frequency TEXT NOT NULL,          -- 'weekly' | 'monthly'
    weekday INTEGER DEFAULT 0,        -- 周定投：0=周一 … 6=周日
    day_of_month INTEGER DEFAULT 1,   -- 月定投：1~28
    enabled INTEGER DEFAULT 1,        -- 1=启用 / 0=暂停
    created_at TEXT NOT NULL,
    last_invested_period TEXT,        -- 本期已投标记（期起始日），防同周期重复扣款
    UNIQUE(fund_code, frequency)
  );
  CREATE INDEX IF NOT EXISTS idx_plan_code ON dingtou_plan(fund_code);
  `,
  // ── 18. app_settings：可编辑参数（设置页：资金规则 / 运行方式 / 风控边界）──
  // key-value 存储（设置页可编辑），缺省用内置默认值。
  `
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT
  );
  `,
  // ── 19. portfolio_daily：组合每日快照（组合资产曲线的数据源）──
  // 组合每日快照。每天一条，由调度器记录。
  `
  CREATE TABLE IF NOT EXISTS portfolio_daily (
    snap_date TEXT NOT NULL,           -- 'YYYY-MM-DD'
    -- 结构隔离：'trade' = 交易盘虚拟持仓曲线 / 'real' = 真实持仓曲线 /
    --              'legacy' = 迁移前的混账历史行（不参与任一曲线，避免污染真钱基准）
    source TEXT NOT NULL DEFAULT 'trade',
    total_assets REAL NOT NULL,        -- 现金 + 持仓市值
    market_value REAL,
    cash REAL,
    total_cost REAL,                   -- 剩余份额对应成本
    unrealized_pnl REAL,               -- 浮动盈亏
    realized_pnl REAL,                 -- 已实现盈亏
    cumulative_pnl REAL,               -- 累计收益 = 浮动 + 已实现
    created_at TEXT NOT NULL,
    PRIMARY KEY (snap_date, source)
  );
  `,
  // ── 20. fx_rate：汇率（USD/CNY 等）──
  // 汇率记录。复合主键 (pair, rate_date)。
  `
  CREATE TABLE IF NOT EXISTS fx_rate (
    pair TEXT NOT NULL,
    rate_date TEXT NOT NULL,
    rate REAL NOT NULL,
    source TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (pair, rate_date)
  );
  `,
  // ── 21. dividends：分红记录（现金分红 / 红利再投）──
  `
  CREATE TABLE IF NOT EXISTS dividends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code TEXT NOT NULL,
    ex_date TEXT NOT NULL,             -- 除息日
    dividend_per_share REAL NOT NULL,  -- 每份分红
    nav_before REAL,
    nav_after REAL,
    reinvest INTEGER DEFAULT 0,        -- 1=红利再投 / 0=现金分红
    source TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(fund_code, ex_date)
  );
  CREATE INDEX IF NOT EXISTS idx_dividends_fund ON dividends(fund_code, ex_date DESC);
  `,
  // ── 22. news_triage：新闻分拣（triage / review 用）──
  `
  CREATE TABLE IF NOT EXISTS news_triage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key TEXT,
    title TEXT,
    source TEXT,
    category TEXT,
    summary TEXT,
    impact_boards TEXT,
    impact_concepts TEXT,
    credibility TEXT,
    is_official INTEGER DEFAULT 0,
    published_at TEXT,
    first_pub_time TEXT,
    processed_at TEXT
  );
  `,
  // ── 23. sector_news：行业/概念板块行情（sector_news / review 用）──
  `
  CREATE TABLE IF NOT EXISTS sector_news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sector TEXT,
    sector_code TEXT,
    change_pct REAL,
    net_inflow REAL,
    leader_stock TEXT,
    leader_change_pct REAL,
    hot_rank INTEGER DEFAULT 0,
    news_title TEXT,
    news_url TEXT,
    news_source TEXT,
    news_summary TEXT,
    fetched_at TEXT,
    board_type TEXT DEFAULT 'industry'
  );
  CREATE INDEX IF NOT EXISTS idx_sector_news_type ON sector_news(board_type, hot_rank);
  `,
  // ── 24. data_health：数据健康记录（health / inspector 用）──
  `
  CREATE TABLE IF NOT EXISTS data_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    data_type TEXT,
    status TEXT,
    record_count INTEGER,
    message TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // ── 25. rule_change_log：规则/状态变动日志（rule_watch 用）──
  `
  CREATE TABLE IF NOT EXISTS rule_change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code TEXT,
    kind TEXT,
    old_value TEXT,
    new_value TEXT,
    detected_at TEXT NOT NULL
  );
  `,
  // ── 26. fund_fee：基金赎回费阶梯缓存（rule_watch 用）──
  `
  CREATE TABLE IF NOT EXISTS fund_fee (
    fund_code TEXT PRIMARY KEY,
    redeem_tiers TEXT,
    redeem_raw TEXT,
    fetched_at TEXT
  );
  `,
  // ── 27. audit_log：审计日志──
  `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  );
  `,
  // ── 28. price_alerts：涨跌 / 净值预警设置 ──
  // kind: 'pct_down'(日跌幅达到) | 'pct_up'(日涨幅达到) | 'nav_below'(单位净值低于) | 'nav_above'(单位净值高于)
  // threshold: pct 类为百分比数值（如 3 表示 3%）；nav 类为净值数值
  // 触发冷却：last_triggered 距现在 < 24h 不再重复通知（避免每次开 App 都弹）
  `
  CREATE TABLE IF NOT EXISTS price_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code TEXT NOT NULL,
    fund_name TEXT,
    kind TEXT NOT NULL,
    threshold REAL NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    last_triggered TEXT,
    trigger_count INTEGER DEFAULT 0,
    UNIQUE(fund_code, kind, threshold)
  );
  CREATE INDEX IF NOT EXISTS idx_price_alerts_code ON price_alerts(fund_code);
  `,
  // ── 29. alert_history：预警触发记录（本地通知 + 历史留痕）──
  `
  CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER,
    fund_code TEXT NOT NULL,
    fund_name TEXT,
    kind TEXT NOT NULL,
    threshold REAL NOT NULL,
    triggered_value REAL,           -- 触发时实际值（pct 为百分比；nav 为净值）
    triggered_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alert_history_at ON alert_history(triggered_at DESC);
  `,
  // ── 30. rebalance_targets：再平衡目标权重 ──
  // fund_code 为主键：一个基金一条目标占比；saveTargets 先清后插，表只服务再平衡。
  `
  CREATE TABLE IF NOT EXISTS rebalance_targets (
    fund_code     TEXT PRIMARY KEY,
    target_weight REAL NOT NULL,       -- 目标占比（%）
    updated_at    TEXT NOT NULL
  );
  `,
  // ── 31. rebalance_history：再平衡提醒记录 ──
  `
  CREATE TABLE IF NOT EXISTS rebalance_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    triggered_at   TEXT NOT NULL,
    need_rebalance INTEGER DEFAULT 0,  -- 1=当时判定需要再平衡
    max_drift      REAL,               -- 当时最大偏离（%）
    detail         TEXT                -- 偏离明细 JSON（每只 实际/目标/偏离）
  );
  CREATE INDEX IF NOT EXISTS idx_rebalance_history_at ON rebalance_history(triggered_at DESC);
  `,
  // ── 32. goal_plan：目标规划（退休 / 教育 / 目标投）──
  // 用户设目标金额 + 目标日期 + 预期年化（用户假设，非承诺）+ 每月定投；
  // 起始本金 initial_amount 为 null 时用「当前真实持仓市值」动态代入。
  `
  CREATE TABLE IF NOT EXISTS goal_plan (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,          -- 目标名（如 退休金 / 教育金）
    target_amount  REAL NOT NULL,          -- 目标金额（元）
    target_date    TEXT NOT NULL,          -- 目标日期 YYYY-MM-DD
    annual_return  REAL NOT NULL,          -- 预期年化收益率（%，用户假设）
    monthly_saving REAL DEFAULT 0,         -- 每月定投（元）
    initial_amount REAL,                   -- 起始本金（null=用当前真实持仓市值）
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  `,
  // ── 全球行情（国外指数 + 商品：实时点位/价格 + 当日涨跌）──
  // 由调度器（App 启动/每日周期）抓取代实时数据落库，指数估值页先读本地再后台补刷。
  // 商品/国外指数无 PE 分位数据源，只存点位/价格 + 涨跌%，不造假。
  `
  CREATE TABLE IF NOT EXISTS global_quotes (
    code        TEXT PRIMARY KEY,          -- XAU / DJIA / NDX / SPX / HSI / N225 / KS11 / XAG / CL
    kind        TEXT NOT NULL,             -- index（国外指数）| commodity（商品）
    name        TEXT NOT NULL,             -- 伦敦金 / 道琼斯 ...
    value       REAL NOT NULL,             -- 最新点位 / 价格
    change_pct  REAL NOT NULL,             -- 当日涨跌幅 %
    updated_at  TEXT NOT NULL              -- 本地时间（落库时刻）
  );
  `,
]

/**
 * 在 @capacitor-community/sqlite 打开/建库后立即批量执行。
 *
 * 错误处理策略：
 *   - 仅吞掉真正的幂等错误（列已存在 / 索引已存在 / 表已存在等）
 *   - 其他错误一律抛出 → sqlite_adapter.ts → dataAdapter.js → _errors → UI
 *
 * 注意：本函数会被多次调用（重复执行是设计期望），但调用方应当保证只在
 * 真机 SQLite 流程中调用一次（init_app.ts 不再调用，详见 init_app.ts:85）。
 */
export async function ensureTables(
  executeSql: (sql: string) => Promise<unknown>,
): Promise<void> {
  for (const sql of SCHEMA_SQL) {
    // 每条 CREATE 可能含多条语句（被 ; 分隔），逐条执行更稳
    for (const stmt of sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
      try {
        await executeSql(stmt)
      } catch (e) {
        const msg = String(e)
        // 只忽略幂等的「已存在」错误（列 / 索引 / 表）
        if (!/duplicate column|already exists|Duplicate index/i.test(msg)) {
          // 真错误：抛出，让上层看到（不要静默吞）
          throw new Error(`[ensureTables] ${msg.slice(0, 200)} | SQL: ${stmt.slice(0, 80)}`)
        }
      }
    }
  }
  // ── 迁移：为 funds 表加 is_favorite 列（仅当列不存在时执行）──
  try {
    await executeSql('ALTER TABLE funds ADD COLUMN is_favorite INTEGER DEFAULT 0')
  } catch (e) {
    // 真正的幂等错误：列已存在 → 静默返回
    // 其他错误（如表不存在、语法错等）→ 抛出
    const msg = String(e)
    if (/duplicate column name/i.test(msg)) { /* 已存在 */ } else {
      throw new Error(`[ensureTables] is_favorite 迁移失败: ${msg.slice(0, 200)}`)
    }
  }
  // ── 迁移：为 funds 表加 dividend_method 列（现金分红 cash / 红利再投 reinvest）──
  try {
    await executeSql("ALTER TABLE funds ADD COLUMN dividend_method TEXT DEFAULT 'cash'")
  } catch (e) {
    const msg = String(e)
    if (!/duplicate column name/i.test(msg)) {
      throw new Error(`[ensureTables] dividend_method 迁移失败: ${msg.slice(0, 200)}`)
    }
  }
  // ── 迁移：为 portfolio_daily 补成本/盈亏列（旧库只有 total_assets/market_value/cash）──
  for (const col of ['total_cost REAL', 'unrealized_pnl REAL', 'realized_pnl REAL', 'cumulative_pnl REAL']) {
    try {
      await executeSql(`ALTER TABLE portfolio_daily ADD COLUMN ${col}`)
    } catch (e) {
      const msg = String(e)
      if (!/duplicate column name/i.test(msg)) {
        throw new Error(`[ensureTables] portfolio_daily 迁移失败: ${msg.slice(0, 200)}`)
      }
    }
  }
  // ── 迁移：为 fund_holdings 加 industry 列──
  try {
    await executeSql('ALTER TABLE fund_holdings ADD COLUMN industry TEXT')
  } catch (e) {
    const msg = String(e)
    if (!/duplicate column name/i.test(msg)) {
      throw new Error(`[ensureTables] fund_holdings.industry 迁移失败: ${msg.slice(0, 200)}`)
    }
  }
  // ── 迁移：为 dingtou_plan 加 last_result 列（上期扣款结果留痕）──
  try {
    await executeSql('ALTER TABLE dingtou_plan ADD COLUMN last_result TEXT')
  } catch (e) {
    const msg = String(e)
    if (!/duplicate column name/i.test(msg)) {
      throw new Error(`[ensureTables] dingtou_plan.last_result 迁移失败: ${msg.slice(0, 200)}`)
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 结构隔离 · 数据层迁移
  //   目的：真实持仓(real) 与 交易盘虚拟持仓(trade) 在**结构上**分开，
  //        不再靠 `buy_order_id LIKE 'ocr-import-%'` 这种约定（约定会被新查询忘掉）。
  // ══════════════════════════════════════════════════════════════════════

  // ── 迁移 1：lots 加 source 列 + 存量回填（ocr-import → real）──
  // 新库由 SCHEMA_SQL 直接建好（带 CHECK 约束）；旧库走 ALTER。
  // 注：ALTER ADD COLUMN 不带 CHECK（SQLite 对 ADD COLUMN 的 CHECK 支持受限），
  //     约束由新库建表语句保证；旧库靠"写入侧只写 real/trade"兜住。
  let lotsSourceAdded = false
  try {
    await executeSql("ALTER TABLE lots ADD COLUMN source TEXT NOT NULL DEFAULT 'trade'")
    lotsSourceAdded = true
  } catch (e) {
    const msg = String(e)
    if (!/duplicate column name/i.test(msg)) {
      throw new Error(`[ensureTables] lots.source 迁移失败: ${msg.slice(0, 200)}`)
    }
  }
  // 存量回填（幂等，无论列是刚加的还是一直在，都跑一次纠正）
  try {
    const n = await executeSql(
      "UPDATE lots SET source='real' WHERE buy_order_id LIKE 'ocr-import-%' AND source<>'real'",
    )
    if (lotsSourceAdded) {
      console.log('[ensureTables] lots.source 迁移完成（新增列 + 存量 ocr-import 归 real）', n)
    }
  } catch (e) {
    throw new Error(`[ensureTables] lots.source 回填失败: ${String(e).slice(0, 200)}`)
  }

  // ── 迁移 2：portfolio_daily 加 source 维度 ──
  // 复合主键 (snap_date, source)：支持同一天 real/trade 各一条。
  // 历史行统一标 'legacy'（既不属于 real 也不属于 trade，避免混账历史污染真钱基准）。
  // 用 pragma_table_info 探测列（比 "SELECT source …" 可靠：空表也能准确判定）
  let pdHasSource = false
  try {
    const r = (await executeSql(
      "SELECT COUNT(*) AS n FROM pragma_table_info('portfolio_daily') WHERE name='source'",
    )) as { values?: { n: number }[] } | undefined
    pdHasSource = (r?.values?.[0]?.n ?? 0) > 0
  } catch {
    pdHasSource = false
  }
  if (!pdHasSource) {
    try {
      await executeSql('ALTER TABLE portfolio_daily RENAME TO portfolio_daily_old')
      await executeSql(`
        CREATE TABLE IF NOT EXISTS portfolio_daily (
          snap_date TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'trade',
          total_assets REAL NOT NULL,
          market_value REAL,
          cash REAL,
          total_cost REAL,
          unrealized_pnl REAL,
          realized_pnl REAL,
          cumulative_pnl REAL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (snap_date, source)
        )
      `)
      await executeSql(`
        INSERT OR IGNORE INTO portfolio_daily
          (snap_date, source, total_assets, market_value, cash, total_cost,
           unrealized_pnl, realized_pnl, cumulative_pnl, created_at)
        SELECT snap_date, 'legacy', total_assets, market_value, cash, total_cost,
               unrealized_pnl, realized_pnl, cumulative_pnl, created_at
          FROM portfolio_daily_old
      `)
      await executeSql('DROP TABLE portfolio_daily_old')
      console.log('[ensureTables] portfolio_daily 复合主键 (snap_date, source)，历史行标 legacy')
    } catch (e) {
      throw new Error(`[ensureTables] portfolio_daily source 迁移失败: ${String(e).slice(0, 200)}`)
    }
  }

  // ── 迁移 3：口径切换 → 重置 peak_assets（只跑一次）──
  // 旧 peak_assets 是「交易盘现金 + 真实/虚拟混账持仓」口径下的历史峰值；
  // 新口径（账户级风控只算真实持仓、不含交易盘现金）与之不可比 →
  // 若不清掉，真实持仓 ¥1,000 对旧峰值（几十万）会算出 -99% 的假回撤、天天误报。
  // 用 pool_meta 标记 isolation_migrated 保证只执行一次（后续启动不再重置，正常累积峰值）。
  try {
    await executeSql(
      "UPDATE pool_meta SET value='0' WHERE key='peak_assets' AND value<>'0' AND NOT EXISTS (" +
      "  SELECT 1 FROM pool_meta p2 WHERE p2.key='isolation_migrated')",
    )
    await executeSql(
      "INSERT OR IGNORE INTO pool_meta (key, value, updated_at) VALUES ('isolation_migrated','1',datetime('now'))",
    )
  } catch (e) {
    console.warn('[ensureTables] peak_assets 重置跳过:', String(e).slice(0, 120))
  }
}

/** 在内存 mock（MemoryBudgetDb）下也建表（用 SQLite 兼容语法通过 _db.exec 跑） */
export const SCHEMA_FOR_MEM_MOCK: string = SCHEMA_SQL.join('\n').replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'INTEGER PRIMARY KEY')