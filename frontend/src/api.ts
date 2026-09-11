import type { Market, SymbolKey } from './data'

export interface Decision {
  symbol: string
  instrument: string
  direction: 'LONG' | 'SHORT' | 'WAIT'
  confidence: number
  score: number
  entry_range: number[]
  stop_loss: number
  take_profit: number[]
  leverage: number
  risk: 'low' | 'medium' | 'high'
  reasons: string[]
  disclaimer: string
}

interface MarketResponse {
  symbol: SymbolKey
  price: number
  change_24h: number
  volume: number
  funding_rate: number
  open_interest: number
  source: 'live' | 'demo'
}

const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1'

function compactUsd(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value)
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
    })
    if (!response.ok) throw new Error(`接口请求失败：${response.status}`)
    return await response.json() as T
  } finally {
    globalThis.clearTimeout(timer)
  }
}

export async function loadMarkets(fallback: Market[]): Promise<{ markets: Market[]; live: boolean }> {
  try {
    const results = await Promise.all(fallback.map(item => request<MarketResponse>(`/market/${item.symbol}`)))
    return {
      live: results.some(item => item.source === 'live'),
      markets: fallback.map(item => {
        const result = results.find(value => value.symbol === item.symbol)!
        return {
          ...item,
          price: result.price,
          change: result.change_24h,
          volume: compactUsd(result.volume),
          funding: `${result.funding_rate.toFixed(4)}%`,
          oi: compactUsd(result.open_interest),
        }
      }),
    }
  } catch {
    return { markets: fallback, live: false }
  }
}

export async function requestAnalysis(symbol: SymbolKey, timeframe: string): Promise<Decision | null> {
  try {
    return await request<Decision>('/ai/analyze', {
      method: 'POST',
      body: JSON.stringify({ symbol, timeframe: timeframe.toLowerCase() }),
    })
  } catch {
    return null
  }
}
