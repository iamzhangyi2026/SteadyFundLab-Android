#!/usr/bin/env python3
"""
sql_audit.py - 全项目 SQL 列名自审工具

做法：
1. 解析 src/data/sqlite_schema.ts 的 CREATE TABLE 语句，提取 {表: [列, ...]}
2. 扫描 src/ 下所有 .ts/.tsx/.js/.jsx 里的 SQL 字面量（query/run 调用）
3. 从 SQL 中提取 FROM/JOIN/UPDATE/INTO 引用的表名
4. 提取每段 SQL 中出现的列名
5. 比对：列不在建表列表 -> 报 [BUG]
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
SCHEMA_FILE = SRC / "data" / "sqlite_schema.ts"

CODE_EXT = {".ts", ".tsx", ".js", ".jsx"}

# === 1) 解析 schema ===
def parse_schema() -> dict:
    text = SCHEMA_FILE.read_text(encoding="utf-8")
    # 关键：先剥行内 SQL 注释，避免 `amount REAL NOT NULL, -- 注释\nmemo ...`
    # 被误合并成一行，导致 memo 列被吞
    text = re.sub(r"--[^\n]*", "", text)
    pattern = re.compile(
        r"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\((.*?)\)\s*;",
        re.DOTALL | re.IGNORECASE,
    )
    schema = {}
    for m in pattern.finditer(text):
        table = m.group(1)
        body = m.group(2)
        cols = []
        for line in body.split(","):
            line = line.strip()
            if not line:
                continue
            up = line.upper().lstrip("(").strip()
            if up.startswith(("PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "CHECK", "CONSTRAINT", "CREATE INDEX", "INDEX ")):
                continue
            tok = re.match(r"`?(\w+)`?", line)
            if tok:
                cols.append(tok.group(1))
        schema[table] = cols
    return schema


# === 2) 抽取所有 SQL 字面量 ===
def extract_sql_chunks(src_files):
    chunks = []
    call_pat = re.compile(r"\.(?:query|run|exec|all)\s*\(\s*([`'\"\"\"'])([^`'\"]*)", re.DOTALL)
    for f in src_files:
        try:
            text = f.read_text(encoding="utf-8")
        except Exception:
            continue
        for m in call_pat.finditer(text):
            sql = m.group(2)
            if not sql or not sql.strip():
                continue
            line = text[: m.start()].count("\n") + 1
            chunks.append((f, line, sql))
    return chunks


# === 3) 从 SQL 块提取引用的表 + 列 ===
TABLE_PATS = [
    re.compile(r"\bFROM\s+(\w+)", re.IGNORECASE),
    re.compile(r"\bJOIN\s+(\w+)", re.IGNORECASE),
    re.compile(r"\bINTO\s+(\w+)", re.IGNORECASE),
    re.compile(r"\bUPDATE\s+(\w+)", re.IGNORECASE),
    re.compile(r"\bDELETE\s+FROM\s+(\w+)", re.IGNORECASE),
]

COL_PATS_BARE = re.compile(r"\b([A-Za-z_]\w*)\b")

KEYWORDS = {
    "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IN",
    "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "JOIN", "LEFT",
    "RIGHT", "INNER", "OUTER", "ON", "AS", "ORDER", "BY", "GROUP", "HAVING",
    "LIMIT", "OFFSET", "ASC", "DESC", "DISTINCT", "ALL", "UNION", "INTERSECT",
    "EXCEPT", "CASE", "WHEN", "THEN", "ELSE", "END", "COALESCE", "IFNULL",
    "COUNT", "SUM", "AVG", "MIN", "MAX", "ROUND", "CAST", "REAL", "INTEGER",
    "TEXT", "BLOB", "PRIMARY", "KEY", "AUTOINCREMENT", "DEFAULT",
    "UNIQUE", "CHECK", "REFERENCES", "FOREIGN", "CREATE", "TABLE", "INDEX",
    "IF", "EXISTS", "DROP", "ALTER", "BEGIN", "COMMIT", "ROLLBACK",
    "TRANSACTION", "BETWEEN", "LIKE", "GLOB", "REGEXP", "ESCAPE",
    "TRUE", "FALSE",
}
FUNC_NAMES = {
    "DATE", "DATETIME", "TIME", "JULIANDAY", "STRFTIME",
    "ABS", "LENGTH", "UPPER", "LOWER", "SUBSTR", "REPLACE", "TRIM",
    "TYPEOF", "ZEROBLOB", "RANDOMBLOB",
}


def references_in_sql(sql):
    cols = set()
    for m in COL_PATS_BARE.finditer(sql):
        tok = m.group(1)
        if tok.upper() in KEYWORDS:
            continue
        if tok.upper() in FUNC_NAMES:
            continue
        if tok.isdigit():
            continue
        if tok.startswith(("'", '"')):
            continue
        cols.add(tok)
    return cols


def tables_in_sql(sql):
    found = []
    for pat in TABLE_PATS:
        for m in pat.finditer(sql):
            found.append(m.group(1).lower())
    return found


# === 4) 比对 ===
def audit():
    schema = parse_schema()
    print("=" * 70)
    print(f"[1] 建表 schema（共 {len(schema)} 张表）")
    for t, cols in sorted(schema.items()):
        print(f"    {t}: {len(cols)} 列")
    print()

    src_files = [
        p for p in SRC.rglob("*")
        if p.is_file() and p.suffix in CODE_EXT
    ]
    chunks = extract_sql_chunks(src_files)
    print(f"[2] 扫描到 {len(chunks)} 个 SQL 块")
    print()

    all_columns = {c.lower() for cols in schema.values() for c in cols}
    table_to_cols = {t: {c.lower() for c in cols} for t, cols in schema.items()}

    issues = []
    ambiguous = []

    for f, line, sql in chunks:
        tables = tables_in_sql(sql)
        if not tables:
            continue
        cols = references_in_sql(sql)
        # 过滤：跳过表名 / 短别名 / 占位符
        tables_lower = {t.lower() for t in tables}
        for col in cols:
            col_l = col.lower()
            # 过滤：表名被当列名（如 'funds' 在 FROM funds 里）
            if col_l in tables_lower:
                continue
            # 过滤：1 字符（明显是别名 o/f/l/u/v）
            if len(col_l) <= 1:
                continue
            # 过滤：常见占位
            if col in {"?", "N", "x", "y", "IGNORE", "REPLACE"}:
                continue
            if col_l in all_columns:
                in_any = [t for t in tables if col_l in table_to_cols.get(t, set())]
                if not in_any:
                    ambiguous.append(f"  [{f.name}:{line}] 列 {col!r} 不在引用表 {tables} 中（可能在别名 / 别表里）")
                continue
            if col.upper() in KEYWORDS or col.upper() in FUNC_NAMES:
                continue
            issues.append(
                f"  [BUG] {f.name}:{line} -- 列 {col!r} 不在任何建表 schema 中  (引用表: {tables})"
            )

    print("=" * 70)
    if issues:
        print(f"[3] 发现 {len(issues)} 个【疑似列名错误】（建议逐条核对）：")
        for s in issues:
            print(s)
    else:
        print("[3] 全部 SQL 引用的列都在建表 schema 中 OK")
    print()
    if ambiguous:
        print(f"[4] {len(ambiguous)} 个【跨表/别名】情况（多半 OK，已列出供人工 review）：")
        for s in ambiguous[:30]:
            print(s)
        if len(ambiguous) > 30:
            print(f"    ... +{len(ambiguous) - 30} 条")
    print("=" * 70)
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(audit())
