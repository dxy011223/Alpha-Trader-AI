export type SymbolKey = 'BTC' | 'ETH' | 'SOL' | 'HYPE'

export interface Market {
  symbol: SymbolKey
  name: string
  price: number
  change: number
  volume: string
  funding: string
  oi: string
  icon: string
  color: string
}

export const markets: Market[] = [
  { symbol: 'BTC', name: 'Bitcoin', price: 82437.2, change: 2.84, volume: '$28.46B', funding: '0.0102%', oi: '$18.72B', icon: '₿', color: '#ffae57' },
  { symbol: 'ETH', name: 'Ethereum', price: 3548.76, change: 1.92, volume: '$14.82B', funding: '0.0084%', oi: '$9.64B', icon: '◆', color: '#838cff' },
  { symbol: 'SOL', name: 'Solana', price: 179.42, change: -0.74, volume: '$3.96B', funding: '-0.0021%', oi: '$2.18B', icon: 'S', color: '#73edc1' },
  { symbol: 'HYPE', name: 'Hyperliquid', price: 39.28, change: 4.63, volume: '$642M', funding: '0.0148%', oi: '$782M', icon: 'H', color: '#65e4db' },
]

export const chartSeries: Record<SymbolKey, number[]> = {
  BTC: [40, 43, 41, 46, 45, 52, 49, 55, 59, 57, 64, 61, 67, 69, 66, 72, 78, 75, 82, 79, 88, 86, 93, 96],
  ETH: [48, 46, 50, 53, 51, 56, 58, 54, 60, 63, 61, 65, 69, 66, 72, 70, 74, 79, 77, 82, 84, 80, 88, 91],
  SOL: [72, 70, 74, 68, 66, 69, 65, 61, 64, 60, 57, 59, 55, 53, 56, 51, 49, 52, 47, 45, 48, 44, 46, 43],
  HYPE: [31, 36, 34, 40, 38, 45, 48, 44, 52, 55, 51, 59, 63, 61, 67, 70, 68, 76, 73, 81, 85, 82, 90, 94],
}

export const news = [
  { time: '12 分钟前', source: 'MACRO WIRE', title: '美联储官员释放谨慎降息信号', body: '流动性预期改善，中期偏利多风险资产。', impact: 4, tags: ['BTC', 'NASDAQ'], tone: 'bullish' },
  { time: '38 分钟前', source: 'CRYPTO BRIEF', title: '现货比特币 ETF 连续三个交易日净流入', body: '机构买盘提供支撑，短线注意获利回吐。', impact: 4, tags: ['BTC'], tone: 'bullish' },
  { time: '1 小时前', source: 'GLOBAL MARKETS', title: '亚洲市场风险偏好小幅回落', body: '影响有限，尚未改变主要趋势结构。', impact: 2, tags: ['ETH', 'SOL'], tone: 'neutral' },
]

