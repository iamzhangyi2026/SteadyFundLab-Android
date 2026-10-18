// Excel 导出（SheetJS / xlsx）。把已映射好中文表头的纯对象数组写成 .xlsx 并触发下载。
//
// xlsx 打包后约 283KB，仅导出时才需要；改为函数内动态 import，
// 首屏不加载它，首次点导出时才去加载（本地几毫秒，无感）。
// rows: 形如 [{ '列A': 1, '列B': 'x' }, ...]；fileName / sheetName 不带扩展名
// 返回导出行数（0 表示无数据）
export async function exportRows(rows, { fileName = 'export', sheetName = 'Sheet1' } = {}) {
  if (!rows || !rows.length) return 0
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, String(sheetName).slice(0, 31))
  XLSX.writeFile(wb, `${fileName}.xlsx`)
  return rows.length
}
