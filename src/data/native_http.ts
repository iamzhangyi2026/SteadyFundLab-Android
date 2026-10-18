/**
 * NativeHttp JS 包装器：通过 Capacitor 调用原生 Java HttpURLConnection，
 * 绕过 WebView fetch 的 DNS/TLS 问题。
 */
export interface NativeHttpResponse {
  status: number
  data: unknown
}

export async function nativeFetch(
  url: string,
  timeoutMs = 30000,
): Promise<NativeHttpResponse> {
  const { NativeHttp } = window as any
  if (!NativeHttp || typeof NativeHttp.get !== 'function') {
    throw new Error('NativeHttp plugin not available')
  }
  try {
    const result = await NativeHttp.get({ url, timeout: timeoutMs })
    const text = result?.result ?? ''
    // 尝试解析 JSON
    try {
      return { status: 200, data: JSON.parse(text) }
    } catch {
      return { status: 200, data: text }
    }
  } catch (e: any) {
    throw new Error(e?.message ?? 'NativeHttp failed')
  }
}
