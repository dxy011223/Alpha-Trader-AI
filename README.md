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

除公共行情和新闻外，API 都要求所有者授权。生产环境的 `OWNER_API_TOKEN` 至少 32 位，只在首次设备授权时提交给 Cloudflare Worker：网页换取一年期 HttpOnly、Secure、SameSite Cookie；Android 换取 HMAC 签名设备令牌并保存到系统 Keystore。后续请求不再从客户端发送主令牌，Worker 验证设备会话后使用服务端主令牌访问 Python API。旧版 Android 保存的主令牌会在升级后自动换取设备会话；本地直连 FastAPI 的开发环境仍使用会话级 Bearer 令牌。生产启动会先执行 Alembic 迁移，开发和测试仍可直接使用 SQLite。

## Docker Compose

复制 `.env.example` 为 `.env`，配置数据库密码后运行：

```bash
docker compose up --build
```

## Render 后端部署

仓库根目录的 `render.yaml` 会创建免费预览规格的 FastAPI Web Service、PostgreSQL 和 Redis-compatible Key Value。首次创建 Blueprint 时必须在 Render 控制台填写 `OWNER_API_TOKEN`；仅需启用 AI 复盘和策略优化时才填写 `AI_API_KEY`。Render 与 Cloudflare Worker 的 `OWNER_API_TOKEN` 必须保持同值，轮换时需同步更新两端，否则 Worker 会将后端鉴权失败标记为服务端配置错误。其余连接地址和加密密钥由平台注入或生成。部署完成后，把 Web Service 的 HTTPS 地址配置为 Cloudflare Worker 的 `BACKEND_API_URL`。

免费 Web Service 在空闲后会休眠，免费 PostgreSQL 会在 30 天后到期，因此仅适合功能验收；正式长期运行应升级对应实例或迁移到长期托管数据库。

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

后端会二次验证 AI 调参方案：五维权重必须合计 100，单项权重和 `min_trade_score` 必须在安全范围内，单次变化不得超过限制。验证通过后才保存新的 `strategy_versions` 记录；不合格方案会被标记为 `rejected`。当前已恢复最初规则决策版本，实际决策固定使用 `v1` 参数，历史或新生成的 AI 调参记录不会影响评分与执行资格复核。

Binance/OKX 凭证使用 `CREDENTIAL_ENCRYPTION_KEY` 在数据库中加密保存，API 只返回脱敏 Key。部署前可运行以下命令生成主密钥，并只写入服务器 `.env`：

```powershell
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

交易所 Key 应关闭交易与提币权限，并配置 IP 白名单；生产环境必须通过 HTTPS 使用。

新闻来自 CoinDesk、CNBC Markets 与 Federal Reserve 的公开 RSS，并按真实发布时间归档；新闻源不可用时不会生成假新闻。交易方向、五维评分、止盈止损、仓位和持仓管理建议由本地规则引擎计算，不依赖外部 AI 服务。配置 `AI_API_KEY` 后，仅复盘分析和策略优化使用 OpenAI Responses API；AI 未配置或调用失败时保留已核验交易事实。所有密钥均通过环境变量配置，禁止硬编码。

Docker Compose 会同时启动 PostgreSQL、Redis、API、Celery Worker 与 Celery Beat。API 仅暴露在容器网络，由前端反向代理访问。Beat 每 5 分钟扫描三个平台并把结果写入 PostgreSQL/Redis，每分钟刷新活动持仓建议，每天北京时间 00:10 为三个平台生成前一日真实交易复盘；周期可通过 `.env` 中的 `MARKET_SCAN_INTERVAL_SECONDS`、`DAILY_REVIEW_HOUR` 和 `DAILY_REVIEW_MINUTE` 调整。

## Cloudflare Sites 与 APK

Sites 使用 `.openai/hosting.json` 的逻辑 `DB` 绑定，Wrangler 发布时会执行 `mobile-app/migrations/` 中的 D1 迁移。`OWNER_API_TOKEN` 必须作为运行时 secret 配置；如需完整的钱包、成交与复盘能力，还要把 `BACKEND_API_URL` 指向已部署的 HTTPS Python API。没有完整后端时，Worker 仍提供 Hyperliquid 公共行情、规则决策、D1 新闻归档、资金设置和模拟钱包，并对钱包成交与复盘等功能明确返回不可用。

可在 `mobile-app` 目录运行 `node scripts/ensure-owner-token.mjs` 生成或保留本机 `.env.local` 中的所有者令牌；脚本不会打印令牌，且该文件不会提交到 Git。

Android release 构建读取 `mobile-app/android/signing.properties`，该文件和 keystore 已被 Git 忽略。必须安全备份同一 keystore 与密码，后续版本才能覆盖安装：

```powershell
cd mobile-app
npm run android:apk
```
