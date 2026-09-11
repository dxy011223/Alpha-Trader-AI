# Alpha Trader AI

面向个人交易者的 AI 交易辅助系统。产品提供市场总览、新闻影响、AI 决策、Hyperliquid 钱包只读监控和交易复盘，不包含自动交易能力。

## 移动端 App（主要界面）

```bash
cd mobile-app
npm ci
Copy-Item .env.example .env.local
npm run dev
```

移动端原型包含 iPhone / Pixel 10 预览壳、单币种 K 线、AI 决策、币种切换、五个底部导航页面和 AI 判断依据弹层。启动后端后，市场快照与 `1m / 5m / 1h / 4h / 1d` K 线会读取 Hyperliquid 公共接口；后端不可用时界面会明确标记并保留演示图。

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

## Docker Compose

复制 `.env.example` 为 `.env`，配置数据库密码后运行：

```bash
docker compose up --build
```

## 主要 API

- `GET /api/v1/market/{symbol}`：BTC、ETH、SOL、HYPE 市场快照
- `GET /api/v1/market/{symbol}/candles`：K 线数据
- `GET /api/v1/news/latest`：新闻及 AI 影响分析
- `POST /api/v1/ai/analyze`：生成入场、止损、止盈与风险计划
- `GET /api/v1/wallet/{address}`：Hyperliquid 钱包只读快照
- `POST /api/v1/review/daily`：生成 AI 决策复盘

行情与钱包通过 Hyperliquid 公共只读接口获取；网络不可用时返回带 `source: demo` 标记的演示数据。新闻和外部 AI 模型密钥均通过环境变量配置，禁止硬编码。
