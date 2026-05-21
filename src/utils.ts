import crypto from 'crypto'

export function validateTgInitData(initData: string): Record<string, string> | null {
  try {
    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    if (!hash) return null
    params.delete('hash')

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN || '')
      .digest()

    const expectedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex')

    if (expectedHash !== hash) return null

    const result: Record<string, string> = {}
    params.forEach((v, k) => { result[k] = v })
    return result
  } catch {
    return null
  }
}

export function parseTgUser(params: Record<string, string>) {
  try {
    return JSON.parse(params.user || '{}') as {
      id: number; first_name?: string; username?: string; photo_url?: string; is_premium?: boolean
    }
  } catch {
    return null
  }
}
