import { useEffect, useMemo, useState } from 'react'
import {
  Activity, ArrowDownRight, ArrowUpRight, BarChart3, Bell, Bot,
  CalendarClock, CheckCircle2, ChevronDown, CircleAlert, CircleDollarSign, Clock3,
  Command, ExternalLink, Gauge, Layers3, LayoutDashboard, Menu, Newspaper,
  RefreshCw, Search, Settings, ShieldCheck, Sparkles, Target, TrendingUp,
  WalletCards, Waves, X,
} from 'lucide-react'
import { chartSeries, markets, news, type SymbolKey } from './data'
import { loadMarkets, requestAnalysis, type Decision } from './api'

type View = 'dashboard' | 'analysis' | 'news' | 'positions' | 'review'

const navItems: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: '市场总览', icon: LayoutDashboard },
  { id: 'analysis', label: 'AI 决策', icon: Bot },
  { id: 'news', label: '新闻雷达', icon: Newspaper },
  { id: 'positions', label: '持仓监控', icon: WalletCards },
  { id: 'review', label: '策略复盘', icon: BarChart3 },
]

function formatPrice(value: number) {
  return value >= 1000
    ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${value.toFixed(2)}`
}

function Sparkline({ symbol, positive = true }: { symbol: SymbolKey; positive?: boolean }) {
  const data = chartSeries[symbol]
  const color = positive ? markets.find(item => item.symbol === symbol)?.color ?? '#72efbd' : '#ff6b7d'
  const points = data.map((value, index) => `${(index / (data.length - 1)) * 100},${42 - ((value - 30) / 70) * 36}`).join(' ')
  return (
    <svg className="sparkline" viewBox="0 0 100 45" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`fill-${symbol}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".3" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,45 ${points} 100,45`} fill={`url(#fill-${symbol})`} />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function PriceChart({ symbol }: { symbol: SymbolKey }) {
  const data = chartSeries[symbol]
  const color = markets.find(item => item.symbol === symbol)?.color ?? '#72efbd'
  const points = data.map((value, index) => `${(index / (data.length - 1)) * 900},${250 - ((value - 30) / 70) * 205}`).join(' ')
  return (
    <div className="price-chart">
      <svg viewBox="0 0 900 270" preserveAspectRatio="none" role="img" aria-label={`${symbol} 价格走势`}>
        <defs>
          <linearGradient id="areaMain" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity=".22" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[45, 95, 145, 195, 245].map(y => <line key={y} x1="0" y1={y} x2="900" y2={y} className="grid-line" />)}
        <polygon points={`0,270 ${points} 900,270`} fill="url(#areaMain)" />
        <polyline points={points} fill="none" stroke={color} strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
        <circle cx="900" cy={250 - ((data[data.length - 1] - 30) / 70) * 205} r="4" fill={color} />
      </svg>
      <div className="chart-labels"><span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span><span>16:00</span><span>现在</span></div>
    </div>
  )
}

function ScoreRing({ score }: { score: number }) {
  return (
    <div className="score-ring" style={{ '--score': `${score * 3.6}deg` } as React.CSSProperties}>
      <div><strong>{score}</strong><span>/100</span></div>
    </div>
  )
}

export default function App() {
  const [view, setView] = useState<View>('dashboard')
  const [symbol, setSymbol] = useState<SymbolKey>('BTC')
  const [timeframe, setTimeframe] = useState('4H')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [updated, setUpdated] = useState('刚刚')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [marketData, setMarketData] = useState(markets)
  const [isLive, setIsLive] = useState(false)
  const [decision, setDecision] = useState<Decision | null>(null)
  const market = useMemo(() => marketData.find(item => item.symbol === symbol)!, [marketData, symbol])
  const baseScore = symbol === 'BTC' ? 82 : symbol === 'ETH' ? 76 : symbol === 'SOL' ? 58 : 87
  const score = decision?.score ?? baseScore
  const direction = decision?.direction ?? (score >= 70 ? 'LONG' : 'WAIT')

  const refreshMarkets = async () => {
    const result = await loadMarkets(markets)
    setMarketData(result.markets)
    setIsLive(result.live)
    setUpdated(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
  }

  useEffect(() => {
    void refreshMarkets()
  }, [])

  const selectView = (next: View) => {
    setView(next)
    setMobileOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const selectSymbol = (next: SymbolKey) => {
    setSymbol(next)
    setDecision(null)
  }

  const analyze = async () => {
    setIsAnalyzing(true)
    const [result] = await Promise.all([
      requestAnalysis(symbol, timeframe),
      new Promise(resolve => window.setTimeout(resolve, 650)),
    ])
    if (result) setDecision(result)
    setIsAnalyzing(false)
    setUpdated('刚刚')
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><TrendingUp size={20} /></div>
          <div><strong>ALPHA TRADER</strong><span>AI INTELLIGENCE</span></div>
          <button className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="关闭菜单"><X size={20} /></button>
        </div>
        <nav>
          <p className="nav-caption">COMMAND CENTER</p>
          {navItems.map(item => (
            <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => selectView(item.id)}>
              <item.icon size={18} /><span>{item.label}</span>{item.id === 'news' && <i>3</i>}
            </button>
          ))}
          <p className="nav-caption secondary">SYSTEM</p>
          <button><Settings size={18} /><span>数据与设置</span></button>
        </nav>
        <div className="sidebar-status">
          <div className="status-head"><span><i /> 系统在线</span><small>V1.0</small></div>
          <div className="status-row"><span>市场数据</span><b className={isLive ? '' : 'demo-state'}>{isLive ? '实时' : '演示'}</b></div>
          <div className="status-row"><span>新闻引擎</span><b>已同步</b></div>
          <div className="status-row"><span>交易权限</span><em>只读</em></div>
        </div>
        <div className="profile">
          <div className="avatar">AT</div><div><strong>Alpha Operator</strong><span>个人工作区</span></div><ChevronDown size={16} />
        </div>
      </aside>
      {mobileOpen && <div className="scrim" onClick={() => setMobileOpen(false)} />}

      <main>
        <header className="topbar">
          <button className="menu-button" onClick={() => setMobileOpen(true)} aria-label="打开菜单"><Menu size={20} /></button>
          <div className="command-search"><Search size={17} /><span>搜索资产、新闻或指令...</span><kbd><Command size={12} /> K</kbd></div>
          <div className="top-actions">
            <div className={`live-pill ${isLive ? '' : 'demo'}`}><i /> {isLive ? 'LIVE' : 'DEMO'}</div>
            <button className="icon-button" aria-label="通知"><Bell size={18} /><i /></button>
            <button className="wallet-button"><WalletCards size={17} /><span>连接钱包</span></button>
          </div>
        </header>

        <div className="workspace">
          <section className="page-heading">
            <div>
              <span className="eyebrow">{view === 'dashboard' ? 'MARKET OVERVIEW' : navItems.find(item => item.id === view)?.label}</span>
              <h1>{view === 'dashboard' ? '早上好，市场正在说话。' : navItems.find(item => item.id === view)?.label}</h1>
              <p>{view === 'dashboard' ? 'AI 已扫描 4 个市场、128 条新闻和 6 项宏观指标。' : '基于实时市场数据的个人交易辅助视图。'}</p>
            </div>
            <div className="heading-actions">
              <div className="market-regime"><span><Activity size={15} /></span><div><small>MARKET REGIME</small><strong>趋势偏多 · 波动扩张</strong></div></div>
              <button className="refresh-button" onClick={() => void refreshMarkets()}><RefreshCw size={15} /> 数据更新于 {updated}</button>
            </div>
          </section>

          {view === 'dashboard' && <section className="market-strip">
            {marketData.map(item => (
              <button key={item.symbol} style={{ '--asset-color': item.color } as React.CSSProperties} className={symbol === item.symbol ? 'selected' : ''} onClick={() => selectSymbol(item.symbol)}>
                <div className="asset-meta"><span className="coin" style={{ color: item.color, background: `${item.color}18` }}>{item.icon}</span><div><strong>{item.symbol}</strong><span>{item.name}</span></div></div>
                <div className="asset-price"><strong>{formatPrice(item.price)}</strong><span className={item.change >= 0 ? 'up' : 'down'}>{item.change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(item.change)}%</span></div>
                <div className="asset-mini-metrics"><span>VOL {item.volume}</span><span>FR {item.funding}</span></div>
                <Sparkline symbol={item.symbol} positive={item.change >= 0} />
              </button>
            ))}
          </section>}

          {view === 'analysis' && <section className="analysis-toolbar">
            <div className="analysis-toolbar-label"><Bot size={17} /><div><small>ANALYSIS TARGET</small><strong>选择分析资产</strong></div></div>
            <div className="symbol-switcher">
              {marketData.map(item => <button key={item.symbol} onClick={() => selectSymbol(item.symbol)} className={symbol === item.symbol ? 'active' : ''}><span style={{ color: item.color }}>{item.icon}</span>{item.symbol}</button>)}
            </div>
            <div className="selected-quote"><span>当前价格</span><strong>{formatPrice(market.price)}</strong><em className={market.change >= 0 ? 'up' : 'down'}>{market.change >= 0 ? '+' : ''}{market.change}%</em></div>
            <div className="selected-quote"><span>资金费率</span><strong>{market.funding}</strong><em>4H 周期</em></div>
          </section>}

          <div className={`dashboard-grid ${view !== 'dashboard' ? 'focus-view' : ''}`}>
            {(view === 'dashboard' || view === 'analysis') && <section className="panel chart-panel">
              <div className="panel-head">
                <div className="selected-asset"><span className="coin large" style={{ color: market.color, background: `${market.color}18` }}>{market.icon}</span><div><h2>{market.symbol} / USD</h2><p>永续合约 · Hyperliquid</p></div></div>
                <div className="timeframes">{['15M', '1H', '4H', '1D'].map(item => <button key={item} className={timeframe === item ? 'active' : ''} onClick={() => setTimeframe(item)}>{item}</button>)}</div>
              </div>
              <div className="quote-row"><strong>{formatPrice(market.price)}</strong><span className={market.change >= 0 ? 'up' : 'down'}>{market.change >= 0 ? '+' : ''}{market.change}% <small>24H</small></span></div>
              <div className="indicator-row"><span><i className="ema-fast" />EMA20 <b>{formatPrice(market.price * .982)}</b></span><span><i className="ema-slow" />EMA50 <b>{formatPrice(market.price * .947)}</b></span><span><i className="vwap" />VWAP <b>{formatPrice(market.price * .968)}</b></span></div>
              <PriceChart symbol={symbol} />
              <div className="market-metrics">
                <div><span>24H 成交量</span><strong>{market.volume}</strong></div>
                <div><span>资金费率</span><strong className={market.funding.startsWith('-') ? 'down' : 'up'}>{market.funding}</strong></div>
                <div><span>未平仓量</span><strong>{market.oi}</strong></div>
                <div><span>波动率</span><strong>{symbol === 'HYPE' ? '6.42%' : '3.12%'}</strong></div>
              </div>
            </section>}

            {(view === 'dashboard' || view === 'analysis') && <section className="panel decision-panel">
              <div className="panel-head compact"><div><span className="panel-kicker"><Sparkles size={14} /> AI DECISION</span><h2>交易决策</h2></div><span className="model-tag">ALPHA V1.4</span></div>
              <div className="decision-summary">
                <ScoreRing score={score} />
                <div><span>综合评分</span><strong className={score >= 70 ? 'up' : 'neutral'}>{score >= 85 ? '强交易机会' : score >= 70 ? '可交易' : '继续观察'}</strong><small>置信度 {decision?.confidence ?? score}%</small></div>
              </div>
              <div className="factor-chips"><span>趋势 <b>24/30</b></span><span>结构 <b>20/25</b></span><span>资金 <b>16/20</b></span></div>
              <div className="signal-row"><span>建议方向</span><strong className={direction === 'LONG' ? 'signal-long' : direction === 'SHORT' ? 'down' : 'signal-wait'}>{direction === 'LONG' ? <ArrowUpRight size={15} /> : direction === 'SHORT' ? <ArrowDownRight size={15} /> : <Clock3 size={15} />}{direction}</strong></div>
              <div className="trade-levels">
                <div><span>建议入场</span><strong>{formatPrice(decision?.entry_range[0] ?? market.price * .992)} — {formatPrice(decision?.entry_range[1] ?? market.price * .997)}</strong></div>
                <div><span>止损</span><strong className="down">{formatPrice(decision?.stop_loss ?? market.price * .974)}</strong></div>
                <div><span>止盈目标</span><strong className="up">{formatPrice(decision?.take_profit[0] ?? market.price * 1.035)} / {formatPrice(decision?.take_profit[1] ?? market.price * 1.072)}</strong></div>
                <div><span>建议杠杆</span><strong>{decision?.leverage ?? 3}× <small>{decision?.risk === 'high' ? '高风险' : decision?.risk === 'low' ? '低风险' : '中等风险'}</small></strong></div>
              </div>
              <div className="ai-reason"><Bot size={16} /><p><strong>ALPHA 观点</strong>{decision?.reasons.join('；') ?? 'EMA 多头排列保持完整，资金费率温和。宏观流动性预期改善，但建议等待回踩确认，避免追高。'}</p></div>
              <button className="analyze-button" onClick={analyze} disabled={isAnalyzing}>{isAnalyzing ? <><RefreshCw className="spin" size={17} /> 正在重新分析...</> : <><Sparkles size={17} /> 重新运行 AI 分析</>}</button>
              <p className="disclaimer"><ShieldCheck size={12} /> 仅供辅助决策，不构成投资建议 · 不会自动下单</p>
            </section>}

            {view === 'dashboard' && <section className="panel context-panel">
              <div className="context-item breadth">
                <span className="context-icon"><Layers3 size={17} /></span>
                <div><small>MARKET BREADTH</small><strong>3 涨 / 1 跌</strong><p>主流币广度偏强，BTC 领涨</p></div>
                <em>75%</em>
              </div>
              <div className="context-item flow">
                <span className="context-icon"><Waves size={17} /></span>
                <div><small>CAPITAL FLOW</small><strong>资金温度适中</strong><p>平均资金费率 0.0078%</p></div>
                <em>正常</em>
              </div>
              <div className="context-item event">
                <span className="context-icon"><CalendarClock size={17} /></span>
                <div><small>NEXT CATALYST</small><strong>美国 CPI 数据</strong><p>明日 20:30 · 高影响事件</p></div>
                <em>28h</em>
              </div>
              <div className="context-item risk">
                <span className="context-icon"><ShieldCheck size={17} /></span>
                <div><small>RISK BUDGET</small><strong>已使用 34%</strong><p>仍有充足风险缓冲</p></div>
                <em>安全</em>
              </div>
            </section>}

            {(view === 'dashboard' || view === 'news') && <section className={`panel news-panel ${view === 'news' ? 'expanded' : ''}`}>
              <div className="panel-head compact"><div><span className="panel-kicker"><Activity size={14} /> LIVE INTELLIGENCE</span><h2>市场情报</h2></div><button onClick={() => selectView('news')}>查看全部 <ExternalLink size={13} /></button></div>
              {view === 'news' && <div className="news-overview">
                <div><span>整体情绪</span><strong className="up">偏多 68</strong><small>较昨日 +7</small></div>
                <div><span>高影响事件</span><strong>2</strong><small>未来 24 小时</small></div>
                <div><span>重点资产</span><strong>BTC · NASDAQ</strong><small>相关性正在上升</small></div>
                <div><span>风险提示</span><strong className="neutral">CPI 前降仓</strong><small>明日 20:30</small></div>
              </div>}
              <div className="news-list">
                {news.map((item, index) => (
                  <article key={item.title}>
                    <div className="news-rail"><span className={item.tone}></span>{index < news.length - 1 && <i />}</div>
                    <div className="news-content">
                      <div className="news-meta"><span>{item.source}</span><small>{item.time}</small><em className={item.tone}>{item.tone === 'bullish' ? '利多' : '中性'}</em></div>
                      <h3>{item.title}</h3><p>{item.body}</p>
                      <div className="news-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}<b>影响 {item.impact}/5</b></div>
                    </div>
                  </article>
                ))}
              </div>
            </section>}

            {(view === 'dashboard' || view === 'positions') && <section className={`panel position-panel ${view === 'positions' ? 'expanded' : ''}`}>
              <div className="panel-head compact"><div><span className="panel-kicker"><Gauge size={14} /> RISK MONITOR</span><h2>持仓与风险</h2></div><span className="read-only">只读模式</span></div>
              {view === 'positions' && <div className="portfolio-breakdown">
                <div><span>可用余额</span><strong>$18,240.17</strong><small>74.8% 可用</small></div>
                <div><span>占用保证金</span><strong>$6,140.45</strong><small>25.2% 已使用</small></div>
                <div><span>实际杠杆</span><strong>1.24×</strong><small>低于风险上限</small></div>
                <div><span>今日已实现</span><strong className="up">+$198.16</strong><small>3 笔已平仓</small></div>
              </div>}
              <div className="portfolio-total"><div><span>账户净值</span><strong>$24,380.62</strong></div><div><span>未实现盈亏</span><strong className="up">+$428.36</strong><small>+1.79%</small></div></div>
              <div className="risk-meter"><div className="risk-label"><span>组合风险</span><strong>低 — 中</strong></div><div className="meter"><i /></div><div className="meter-scale"><span>安全</span><span>谨慎</span><span>高风险</span></div></div>
              <div className="position-card">
                <div className="position-title"><div><span className="coin mini">₿</span><strong>BTC-PERP</strong><em>LONG 3×</em></div><b className="up">+$230.20</b></div>
                <div className="position-details"><div><span>入场价</span><strong>$79,240.00</strong></div><div><span>标记价</span><strong>{formatPrice(marketData[0].price)}</strong></div><div><span>仓位</span><strong>0.072 BTC</strong></div></div>
                <div className="monitor-note"><ShieldCheck size={14} /><span>结构有效，当前建议</span><strong>HOLD</strong></div>
              </div>
              <div className="stress-row"><span><CircleAlert size={13} /> 压力测试</span><p>BTC -5% 时，组合预计回撤</p><strong>-1.08%</strong></div>
            </section>}

            {view === 'dashboard' && <section className="panel playbook-panel">
              <div className="playbook-title"><div><span className="panel-kicker"><Target size={14} /> TODAY'S PLAYBOOK</span><h2>今日交易剧本</h2></div><span className="session-badge">纽约盘前</span></div>
              <div className="playbook-steps">
                <div className="play-step active"><b>01</b><span><strong>等待回踩入场区</strong><small>BTC $81,780 — $82,190</small></span><em>当前</em></div>
                <div className="play-step"><b>02</b><span><strong>确认成交量放大</strong><small>1H 成交量高于 20 日均值</small></span><CheckCircle2 size={16} /></div>
                <div className="play-step"><b>03</b><span><strong>执行风险约束</strong><small>单笔风险 ≤ 账户净值 1%</small></span><ShieldCheck size={16} /></div>
              </div>
              <div className="avoid-box"><CircleAlert size={16} /><div><strong>今日避免</strong><span>高资金费率追涨；CPI 公布前 30 分钟新开仓</span></div></div>
            </section>}

            {view === 'review' && <section className="panel review-panel">
              <div className="panel-head compact"><div><span className="panel-kicker"><Target size={14} /> MODEL REVIEW</span><h2>AI 决策复盘 · 近 100 次</h2></div><span className="model-tag">STRATEGY V1.4</span></div>
              <div className="review-hero">
                <ScoreRing score={63} />
                <div><span>方向判断正确率</span><strong>63 / 100</strong><p>较上一策略版本提升 <em>+4.8%</em></p></div>
                <div className="review-count good"><span>正确决策</span><strong>63</strong></div>
                <div className="review-count bad"><span>错误决策</span><strong>37</strong></div>
              </div>
              <div className="review-columns">
                <div>
                  <h3>策略因子表现</h3>
                  {[['趋势跟随', 78], ['技术结构', 71], ['资金指标', 66], ['宏观环境', 59], ['新闻情绪', 54]].map(([label, value]) => (
                    <div className="factor" key={label}><span>{label}</span><div><i style={{ width: `${value}%` }} /></div><strong>{value}</strong></div>
                  ))}
                </div>
                <div>
                  <h3>错误归因与模型调整</h3>
                  <div className="finding"><b>01</b><p><strong>高波动突破的假信号增加</strong><span>突破策略在波动率高于 6% 时胜率下降至 41%。</span></p></div>
                  <div className="finding"><b>02</b><p><strong>高资金费率环境追多回撤更大</strong><span>正费率拥挤时，止损触发概率提高 18%。</span></p></div>
                  <div className="adjustment"><Sparkles size={15} /><p><strong>下一版本建议</strong><span>降低突破策略权重 15%，提高资金指标权重 10%。</span></p></div>
                </div>
              </div>
            </section>}
          </div>

          <footer><span className={isLive ? 'live-source' : ''}><CircleDollarSign size={13} /> {isLive ? 'Hyperliquid 实时行情' : '后端未连接 · 当前为演示数据'}</span><span>Alpha Trader AI · 个人交易决策系统</span></footer>
        </div>
      </main>
    </div>
  )
}
