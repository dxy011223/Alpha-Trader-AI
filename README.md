# Alpha Trader AI

面向个人交易者的 AI 交易辅助系统。产品提供市场总览、新闻影响、AI 决策、Hyperliquid/Binance/OKX 只读账户监控和交易复盘，不包含自动交易能力。

## 移动端 App（主要界面）

```bash
cd mobile-app
npm ci
Copy-Item .env.example .env.local
npm run dev
```

移动端原型包含 iPhone / Pixel 10 预览壳、单币种 K 线、AI 决策、币种切换、五个底部导航页面和 AI 判断依据弹层。启动后端后，市场快照与 `1m / 5m / 1h / 4h / 1d` K 线会读取交易所公共接口；决策、最多三个计划持仓、动态管理建议、真实完成交易和复盘均由后端持久化。

模拟交易按平台独立保存，默认净值为 1000 USDC。净值只用于累计盈亏与复盘，不限制模拟开仓资金；最多同时执行三项可交易决策，并按计划止盈止损自动完成模拟结算。模拟执行不会调用任何交易所下单接口，也不会写入真实策略训练样本。

市场页左上角可在 Hyperliquid、Binance 永续和 OKX 永续之间切换，选择会保存在当前设备。行情、全市场机会扫描、决策、持仓、成交历史和复盘会统一跟随当前平台；已开始执行的决策仍保留创建时的平台，不会被切换后的行情覆盖。

持仓页支持 MetaMask、Rabby 等浏览器注入钱包，并在配置 `VITE_WALLETCONNECT_PROJECT_ID` 后通过 Reown AppKit 连接 Android 外部钱包。Project ID 需从 Reown Dashboard 创建，并为正式域名或 Android 应用标识配置允许列表；未配置时仍可手动填写只读公开地址。

## 网页版工作台

```bash
cd frontend
npm install
npm run dev
```

## 后端 API

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

API 文档：`http://localhost:8000/docs`。未配置 PostgreSQL 时，本地开发默认使用 SQLite。

除公共行情和新闻外，API 都要求 `Authorization: Bearer <OWNER_API_TOKEN>`。生产环境的所有者令牌至少 32 位；App 在市场页设置中保存到当前会话，不写入构建文件。生产启动会先执行 Alembic 迁移，开发和测试仍可直接使用 SQLite。

## Docker Compose

复制 `.env.example` 为 `.env`，配置数据库密码后运行：

```bash
docker compose up --build
```

## 主要 API

- `GET /api/v1/market/{symbol}`：指定平台任意可用永续合约市场快照
- `GET /api/v1/market/{symbol}/candles`：K 线数据
- `GET /api/v1/news/latest`：新闻及 AI 影响分析
- `POST /api/v1/ai/analyze`：生成入场、止损、止盈与风险计划
- `GET|PUT /api/v1/settings/wallet`：保存 Hyperliquid 只读公开地址
- `GET|PUT /api/v1/settings/platform/{binance|okx}`：读取状态或加密保存交易所只读凭证
- `GET /api/v1/executions/active/all`：恢复最多三个正在跟踪的决策和计划持仓
- `GET /api/v1/positions/monitor`：刷新只读的持有、减仓、退出或调整止损建议
- `POST /api/v1/executions`：开始跟踪决策，不会向交易所下单
- `POST /api/v1/positions/{id}/complete`：核对真实平仓成交并完成交易
- `GET /api/v1/trades/completed`：读取真实完成交易
- `GET /api/v1/reviews`：读取持久化复盘记录
- `GET /api/v1/strategies/versions`：只读查询策略版本、参数及其真实样本绩效依据
- `GET /api/v1/wallet/{address}`：Hyperliquid 钱包只读快照
- `GET /api/v1/platforms/{binance|okx}/account`：交易所只读账户、持仓与指定币种成交
- `POST /api/v1/review/daily`：生成并保存每日真实交易复盘

每日复盘使用当前策略版本最近最多 100 笔真实完成交易。后端只整理成交、盈亏、胜负、五维评分快照等可核验事实；复盘总结、错误归因、改进建议、是否调参及完整新参数全部由 AI 通过结构化输出生成。样本不足 20 笔时 AI 只能建议继续观察；达到门槛后，AI 才能提出新版本。

行情通过三家平台的公共接口获取。Hyperliquid 使用公开钱包地址；Binance/OKX 使用用户自行创建的只读 API 凭证，后端仅调用账户、持仓和成交历史 GET 接口，不包含下单或撤单调用。完成交易时必须同时找到决策开始后的真实开仓与平仓成交；退出价按成交量加权，净盈亏按交易所已实现盈亏减去 USDT/USDC 手续费计算。其他手续费币种在尚未换算前会拒绝生成错误复盘。AI 不能修改任何成交事实；AI 未配置、拒绝或调用失败时，复盘仅保留事实并标记 `analysis_engine: facts`，不会使用规则分析或规则调参代替。

后端会二次验证 AI 调参方案：五维权重必须合计 100，单项权重和 `min_trade_score` 必须在安全范围内，单次变化不得超过限制。验证通过后才保存新的 `strategy_versions` 记录；不合格方案会被标记为 `rejected`，不会由规则引擎修正或替代。该流程只影响后续研究评分与执行资格复核，不会自动下单、撤单或修改已核验成交。

Binance/OKX 凭证使用 `CREDENTIAL_ENCRYPTION_KEY` 在数据库中加密保存，API 只返回脱敏 Key。部署前可运行以下命令生成主密钥，并只写入服务器 `.env`：

```powershell
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

交易所 Key 应关闭交易与提币权限，并配置 IP 白名单；生产环境必须通过 HTTPS 使用。

新闻来自 CoinDesk、CNBC Markets 与 Federal Reserve 的公开 RSS，并按真实发布时间归档；新闻源不可用时不会生成假新闻。配置 `AI_API_KEY` 后，交易决策、持仓管理、复盘分析和策略优化均通过 OpenAI Responses API 结构化输出生成，后端只校验数据边界、数学一致性和禁止自动交易约束；AI 未配置或调用失败时不会回退为规则决策。所有密钥均通过环境变量配置，禁止硬编码。

Docker Compose 会同时启动 PostgreSQL、Redis、API、Celery Worker 与 Celery Beat。API 仅暴露在容器网络，由前端反向代理访问。Beat 每 5 分钟扫描三个平台并把结果写入 PostgreSQL/Redis，每分钟刷新活动持仓建议，每天北京时间 00:10 为三个平台生成前一日真实交易复盘；周期可通过 `.env` 中的 `MARKET_SCAN_INTERVAL_SECONDS`、`DAILY_REVIEW_HOUR` 和 `DAILY_REVIEW_MINUTE` 调整。

## Cloudflare Sites 与 APK

Sites 使用 `.openai/hosting.json` 的逻辑 `DB` 绑定，发布时会执行 `mobile-app/drizzle/` 中的 D1 迁移。`OWNER_API_TOKEN` 必须作为运行时 secret 配置；如需完整的钱包、成交与复盘能力，还要把 `BACKEND_API_URL` 指向已部署的 HTTPS Python API。没有完整后端时，Worker 只提供 Hyperliquid 公共行情、D1 新闻归档、资金设置和模拟钱包，并对其余功能明确返回不可用。

可在 `mobile-app` 目录运行 `node scripts/ensure-owner-token.mjs` 生成或保留本机 `.env.local` 中的所有者令牌；脚本不会打印令牌，且该文件不会提交到 Git。

Android release 构建读取 `mobile-app/android/signing.properties`，该文件和 keystore 已被 Git 忽略。必须安全备份同一 keystore 与密码，后续版本才能覆盖安装：

```powershell
cd mobile-app
npm run android:apk
```
