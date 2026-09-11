import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadMarkets, requestAnalysis } from './api'
import { markets } from './data'

afterEach(() => vi.unstubAllGlobals())

describe('API 数据适配', () => {
  it('后端不可用时回退到演示行情', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const result = await loadMarkets(markets)
    expect(result.live).toBe(false)
    expect(result.markets).toEqual(markets)
  })

  it('正确返回 AI 分析结果', async () => {
    const decision = {
      symbol: 'BTC', instrument: 'BTC-PERP', direction: 'LONG', confidence: 81,
      score: 81, entry_range: [76000, 76500], stop_loss: 74500,
      take_profit: [79000, 82000], leverage: 3, risk: 'medium',
      reasons: ['趋势向上'], disclaimer: '不会自动下单',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => decision }))
    await expect(requestAnalysis('BTC', '4H')).resolves.toEqual(decision)
  })
})

