# Coze Workflow MVP

这是一个最小版 Coze Workflow 调用项目。前端只提供 4 个业务输入字段，后端负责读取 `.env` 中的 Coze OpenAPI Token 和固定 workflow parameters，然后调用已发布的 Coze Workflow 流式接口：

```text
POST https://api.coze.cn/v1/workflow/stream_run
```

本项目只用于第一阶段 MVP：能成功调用工作流并看到返回结果。不包含登录、数据库、权限系统、历史记录、任务看板、ERP 嵌入、文件上传、Docker、React、Vue 或 Next.js。

## 目录结构

```text
coze-workflow-mvp/
├── package.json
├── server.js
├── .env.example
├── .gitignore
├── README.md
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

## 环境要求

- Node.js >= 18
- npm

Node.js 需要 18 或更高版本，因为后端使用 Node.js 内置的 `fetch`。

## 安装步骤

进入项目目录：

```bash
cd coze-workflow-mvp
```

安装依赖：

```bash
npm install
```

## 配置 .env

复制环境变量文件。

Windows PowerShell：

```powershell
copy .env.example .env
```

macOS / Linux：

```bash
cp .env.example .env
```

然后编辑 `.env`：

```env
# 服务端口
PORT=3000

# Coze API 配置
COZE_API_BASE=https://api.coze.cn
COZE_PAT=请填写你的Coze访问令牌
COZE_WORKFLOW_ID=请填写你的workflow_id

# 工作流 parameters 内部固定参数
# 注意：这些不是前端输入，而是后端固定传给 Coze 工作流的参数
WORKFLOW_API_TOKEN=请填写你的业务api_token
WORKFLOW_APP_ID=请填写你的业务app_id
WORKFLOW_APP_SECRET=请填写你的业务app_secret
WORKFLOW_KEY=请填写你的业务key
```

说明：

- `COZE_PAT` 是调用 Coze OpenAPI 的 Bearer Token。
- `COZE_WORKFLOW_ID` 是 Coze 工作流 ID，后端会作为字符串传给 Coze。
- `WORKFLOW_API_TOKEN`、`WORKFLOW_APP_ID`、`WORKFLOW_APP_SECRET`、`WORKFLOW_KEY` 是当前 workflow parameters 中需要的固定业务参数。
- 不要把 `.env` 提交到 Git 仓库。

## 启动

开发启动：

```bash
npm run dev
```

或直接启动：

```bash
npm start
```

启动后访问：

```text
http://localhost:3000
```

## 页面使用

页面只允许用户填写 4 个字段：

- `platform_in`
- `platform_out`
- `url`
- `prompt`

前端请求后端时只发送：

```json
{
  "platform_in": "小红书",
  "platform_out": "公众号",
  "url": "https://example.com",
  "prompt": "科技风"
}
```

`api_token`、`app_id`、`app_secret`、`key` 不会出现在页面、前端代码或浏览器请求体中。后端会从 `.env` 读取这些固定参数，并在调用 Coze 时自动合并到 `parameters`。

## 接口说明

### GET /api/health

健康检查接口。

响应示例：

```json
{
  "ok": true,
  "service": "coze-workflow-mvp"
}
```

### POST /api/run-workflow

调用 Coze Workflow。

请求体：

```json
{
  "platform_in": "小红书",
  "platform_out": "公众号",
  "url": "https://example.com",
  "prompt": "科技风"
}
```

成功响应：

```json
{
  "success": true,
  "request_id": "local-1730000000000-abcd1234",
  "coze_status": 200,
  "result": {
    "parsedText": "...",
    "rawText": "...",
    "events": []
  }
}
```

失败响应：

```json
{
  "success": false,
  "message": "错误原因",
  "detail": "可读的错误详情，不包含密钥"
}
```

## Coze 请求格式

后端调用 Coze 时，请求体严格保持为：

```json
{
  "workflow_id": "你的 workflow_id",
  "parameters": {
    "api_token": "来自 WORKFLOW_API_TOKEN",
    "app_id": "来自 WORKFLOW_APP_ID",
    "app_secret": "来自 WORKFLOW_APP_SECRET",
    "key": "来自 WORKFLOW_KEY",
    "platform_in": "小红书",
    "platform_out": "公众号",
    "url": "https://example.com",
    "prompt": "科技风"
  }
}
```

当前 MVP 不会传顶层 `app_id`、`bot_id`、`workflow_version`、`connector_id` 或 `ext`。

## 常见问题

### 1. 启动时报 fetch 不存在

请确认 Node.js 版本 >= 18：

```bash
node -v
```

### 2. 页面提示服务端配置不完整

请检查 `.env` 是否存在，并确认以下配置都已填写：

- `COZE_PAT`
- `COZE_WORKFLOW_ID`
- `WORKFLOW_API_TOKEN`
- `WORKFLOW_APP_ID`
- `WORKFLOW_APP_SECRET`
- `WORKFLOW_KEY`

### 3. Coze 返回 401 或鉴权失败

通常是 `COZE_PAT` 不正确、已过期，或没有权限访问该 workflow。请重新检查 Coze OpenAPI 访问令牌。

### 4. Coze 返回 workflow 相关错误

请检查 `COZE_WORKFLOW_ID` 是否填写正确，并确认该工作流已经发布。

### 5. 页面没有 parsedText，但 rawText 有内容

`stream_run` 返回结构可能和默认提取规则不同。当前后端会完整保留 `rawText`，你可以先根据原始返回确认 Coze 实际字段，再扩展 `server.js` 中的解析逻辑。

### 6. 是否可以把 api_token、app_id、app_secret、key 放到页面？

不可以。当前 MVP 中这 4 个字段都是固定业务配置，只能写在后端 `.env` 中，由后端调用 Coze 时自动补齐。

### 7. 可以提交 .env 吗？

不可以。`.env` 包含敏感密钥，`.gitignore` 已经忽略该文件。请只提交 `.env.example`。
