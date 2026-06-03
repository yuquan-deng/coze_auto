const path = require("path");
const crypto = require("crypto");
const express = require("express");
const dotenv = require("dotenv");
const {
  buildWorkflowResult,
  createProgressTracker,
  createSseStreamParser
} = require("./lib/workflow-stream");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SERVICE_NAME = "coze-workflow-mvp";
const ALLOWED_INPUT_PLATFORMS = ["小红书", "公众号", "抖音"];
const ALLOWED_OUTPUT_PLATFORMS = ["公众号", "小红书"];
const REQUIRED_ENV_KEYS = [
  "COZE_PAT",
  "COZE_WORKFLOW_ID",
  "WORKFLOW_API_TOKEN",
  "WORKFLOW_APP_ID",
  "WORKFLOW_APP_SECRET",
  "WORKFLOW_KEY"
];

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function maskSecret(secret) {
  if (!secret) {
    return "";
  }

  const value = String(secret);

  if (value.length <= 8) {
    return "****";
  }

  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeText(text) {
  if (text === undefined || text === null) {
    return "";
  }

  let safeText = typeof text === "string" ? text : JSON.stringify(text);
  const sensitiveValues = [
    process.env.COZE_PAT,
    process.env.WORKFLOW_API_TOKEN,
    process.env.WORKFLOW_APP_ID,
    process.env.WORKFLOW_APP_SECRET,
    process.env.WORKFLOW_KEY
  ].filter(Boolean);

  for (const secret of sensitiveValues) {
    safeText = safeText.replace(new RegExp(escapeRegExp(secret), "g"), maskSecret(secret));
  }

  return safeText;
}

function getMissingEnvKeys() {
  return REQUIRED_ENV_KEYS.filter((key) => !process.env[key] || !String(process.env[key]).trim());
}

function assertRequiredEnv() {
  const missingKeys = getMissingEnvKeys();

  if (missingKeys.length > 0) {
    const error = new Error(`缺少必要环境变量：${missingKeys.join(", ")}`);
    error.statusCode = 500;
    throw error;
  }
}

function createRequestId() {
  return `local-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function parseDataValue(rawData) {
  const value = rawData.trim();

  if (!value) {
    return "";
  }

  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

function pushSseEvent(events, currentEvent) {
  if (!currentEvent.event && currentEvent.dataLines.length === 0) {
    return;
  }

  const rawData = currentEvent.dataLines.join("\n");

  events.push({
    event: currentEvent.event || "",
    data: parseDataValue(rawData),
    rawData
  });
}

function extractTextFromValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    const text = value.trim();

    if (!text || text === "{}" || text === "[]" || text === "null") {
      return "";
    }

    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value) && value.length === 0) {
    return "";
  }

  if (!Array.isArray(value) && typeof value === "object" && Object.keys(value).length === 0) {
    return "";
  }

  return JSON.stringify(value, null, 2);
}

function extractParsedText(events) {
  const textFields = ["content", "text", "output", "answer", "message", "data"];
  const parts = [];

  for (const item of events) {
    const eventName = String(item.event || "").toUpperCase();

    if (eventName === "PING" || eventName === "DONE") {
      continue;
    }

    const data = item.data;

    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const field of textFields) {
        if (Object.prototype.hasOwnProperty.call(data, field)) {
          const text = extractTextFromValue(data[field]).trim();

          if (text) {
            parts.push(text);
          }

          break;
        }
      }
    }
  }

  return parts.join("\n").trim();
}

function extractStreamMeta(events) {
  const meta = {
    hasDone: false,
    hasError: false,
    debugUrl: "",
    errorMessage: "",
    errorCode: ""
  };

  for (const item of events) {
    const eventName = String(item.event || "").toUpperCase();
    const data = item.data;

    if (eventName === "DONE") {
      meta.hasDone = true;
    }

    if (eventName === "ERROR") {
      meta.hasError = true;
    }

    if (data && typeof data === "object" && !Array.isArray(data)) {
      if (data.debug_url) {
        meta.debugUrl = data.debug_url;
      }

      if (data.error_message) {
        meta.errorMessage = data.error_message;
      }

      if (data.error_code !== undefined && data.error_code !== null) {
        meta.errorCode = String(data.error_code);
      }
    }
  }

  return meta;
}

function parseSseEvents(rawText) {
  const events = [];
  const lines = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let currentEvent = {
    event: "",
    dataLines: []
  };

  for (const line of lines) {
    if (line.trim() === "") {
      pushSseEvent(events, currentEvent);
      currentEvent = {
        event: "",
        dataLines: []
      };
      continue;
    }

    if (line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      currentEvent.event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      currentEvent.dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  pushSseEvent(events, currentEvent);

  return events;
}

async function readCozeStream(response) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("Coze 响应不是可读取的流式响应");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let rawText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      rawText += decoder.decode(value, { stream: true });
    }

    rawText += decoder.decode();
  } catch (error) {
    throw new Error(`读取 Coze 流式响应失败：${error.message}`);
  }

  const events = parseSseEvents(rawText);
  const parsedText = extractParsedText(events);
  const meta = extractStreamMeta(events);

  return {
    rawText,
    events,
    parsedText,
    meta
  };
}

function validateWorkflowInput(body) {
  const platformIn = typeof body.platform_in === "string" ? body.platform_in.trim() : "";
  const platformOut = typeof body.platform_out === "string" ? body.platform_out.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";

  if (!ALLOWED_INPUT_PLATFORMS.includes(platformIn)) {
    return {
      ok: false,
      statusCode: 400,
      message: "platform_in 参数不合法",
      detail: `platform_in 必须是以下之一：${ALLOWED_INPUT_PLATFORMS.join("、")}`
    };
  }

  if (!ALLOWED_OUTPUT_PLATFORMS.includes(platformOut)) {
    return {
      ok: false,
      statusCode: 400,
      message: "platform_out 参数不合法",
      detail: `platform_out 必须是以下之一：${ALLOWED_OUTPUT_PLATFORMS.join("、")}`
    };
  }

  if (!url) {
    return {
      ok: false,
      statusCode: 400,
      message: "url 参数不能为空",
      detail: "请填写内容链接"
    };
  }

  return {
    ok: true,
    value: {
      platform_in: platformIn,
      platform_out: platformOut,
      url,
      prompt
    }
  };
}

function sendError(res, statusCode, message, detail) {
  return res.status(statusCode).json({
    success: false,
    message,
    detail: sanitizeText(detail || message)
  });
}

function setNdjsonHeaders(res, statusCode = 200) {
  res.status(statusCode);
  res.set({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no"
  });
}

function writeNdjson(res, payload) {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  res.write(`${JSON.stringify(payload)}\n`);
}

function writeStreamError(res, message, detail, startedAt, result) {
  const payload = {
    type: "error",
    message,
    detail: sanitizeText(detail || message),
    elapsedMs: Math.max(0, Date.now() - startedAt)
  };

  if (result) {
    payload.result = result;
  }

  writeNdjson(res, payload);
}

async function streamCozeResponse(cozeResponse, res, progressTracker) {
  if (!cozeResponse.body || typeof cozeResponse.body.getReader !== "function") {
    throw new Error("Coze 响应不是可读取的流式响应");
  }

  const reader = cozeResponse.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const events = [];
  let rawText = "";

  const parser = createSseStreamParser((event) => {
    events.push(event);
    writeNdjson(res, progressTracker.updateFromSseEvent(event));
  });

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const text = decoder.decode(value, { stream: true });
      rawText += text;
      parser.push(text);
    }

    const tail = decoder.decode();
    rawText += tail;

    if (tail) {
      parser.push(tail);
    }

    parser.flush();
  } catch (error) {
    throw new Error(`读取 Coze 流式响应失败：${error.message}`);
  }

  return buildWorkflowResult(rawText, events);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME
  });
});

app.post("/api/run-workflow-stream", async (req, res) => {
  const requestId = createRequestId();
  const startedAt = Date.now();
  const progressTracker = createProgressTracker({ startedAt });
  const validation = validateWorkflowInput(req.body || {});

  if (!validation.ok) {
    setNdjsonHeaders(res, validation.statusCode);
    writeStreamError(res, validation.message, validation.detail, startedAt);
    return res.end();
  }

  try {
    assertRequiredEnv();
  } catch (error) {
    console.error(`[${requestId}] 配置错误：${sanitizeText(error.message)}`);
    setNdjsonHeaders(res, error.statusCode || 500);
    writeStreamError(res, "服务端配置不完整", error.message, startedAt);
    return res.end();
  }

  setNdjsonHeaders(res);
  writeNdjson(res, progressTracker.createProgress("submitting", "正在提交请求", "", ""));

  const { platform_in, platform_out, url, prompt } = validation.value;
  const apiBase = (process.env.COZE_API_BASE || "https://api.coze.cn").replace(/\/+$/, "");
  const cozeUrl = `${apiBase}/v1/workflow/stream_run`;
  const cozePayload = {
    workflow_id: String(process.env.COZE_WORKFLOW_ID),
    parameters: {
      api_token: process.env.WORKFLOW_API_TOKEN,
      app_id: process.env.WORKFLOW_APP_ID,
      app_secret: process.env.WORKFLOW_APP_SECRET,
      key: process.env.WORKFLOW_KEY,
      platform_in,
      platform_out,
      url,
      prompt
    }
  };

  let cozeResponse;

  try {
    cozeResponse = await fetch(cozeUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.COZE_PAT}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(cozePayload)
    });
  } catch (error) {
    console.error(`[${requestId}] Coze 网络请求失败：${sanitizeText(error.message)}`);
    writeStreamError(res, "Coze API 网络请求失败", error.message, startedAt);
    return res.end();
  }

  if (!cozeResponse.ok) {
    let errorText = "";

    try {
      errorText = await cozeResponse.text();
    } catch (error) {
      errorText = `读取 Coze 错误响应失败：${error.message}`;
    }

    console.error(
      `[${requestId}] Coze API 返回非 2xx：status=${cozeResponse.status}, body=${sanitizeText(errorText)}`
    );

    writeStreamError(
      res,
      `Coze API 返回异常状态：${cozeResponse.status}`,
      errorText || cozeResponse.statusText,
      startedAt
    );
    return res.end();
  }

  writeNdjson(
    res,
    progressTracker.createProgress("connected", "已连接 Coze，正在等待工作流事件", "", "")
  );

  try {
    const result = await streamCozeResponse(cozeResponse, res, progressTracker);
    const meta = result.meta || {};

    if (meta.hasError || meta.hasInterrupt) {
      const message = meta.hasInterrupt ? "工作流已中断" : "工作流返回了错误事件";
      const detail = [
        meta.errorCode && `错误码：${meta.errorCode}`,
        meta.errorMessage && `错误信息：${meta.errorMessage}`,
        meta.debugUrl && `Coze 调试链接：${meta.debugUrl}`
      ]
        .filter(Boolean)
        .join("\n");

      writeStreamError(res, message, detail || message, startedAt, result);
    } else {
      writeNdjson(res, {
        type: "complete",
        result
      });
    }

    return res.end();
  } catch (error) {
    console.error(`[${requestId}] Coze 流式响应读取失败：${sanitizeText(error.message)}`);
    writeStreamError(res, "Coze 流式响应读取失败", error.message, startedAt);
    return res.end();
  }
});

app.post("/api/run-workflow", async (req, res) => {
  const requestId = createRequestId();
  const validation = validateWorkflowInput(req.body || {});

  if (!validation.ok) {
    return sendError(res, validation.statusCode, validation.message, validation.detail);
  }

  try {
    assertRequiredEnv();
  } catch (error) {
    console.error(`[${requestId}] 配置错误：${sanitizeText(error.message)}`);
    return sendError(res, error.statusCode || 500, "服务端配置不完整", error.message);
  }

  const { platform_in, platform_out, url, prompt } = validation.value;
  const apiBase = (process.env.COZE_API_BASE || "https://api.coze.cn").replace(/\/+$/, "");
  const cozeUrl = `${apiBase}/v1/workflow/stream_run`;
  const cozePayload = {
    workflow_id: String(process.env.COZE_WORKFLOW_ID),
    parameters: {
      api_token: process.env.WORKFLOW_API_TOKEN,
      app_id: process.env.WORKFLOW_APP_ID,
      app_secret: process.env.WORKFLOW_APP_SECRET,
      key: process.env.WORKFLOW_KEY,
      platform_in,
      platform_out,
      url,
      prompt
    }
  };

  let cozeResponse;

  try {
    cozeResponse = await fetch(cozeUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.COZE_PAT}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(cozePayload)
    });
  } catch (error) {
    console.error(`[${requestId}] Coze 网络请求失败：${sanitizeText(error.message)}`);
    return sendError(res, 502, "Coze API 网络请求失败", error.message);
  }

  if (!cozeResponse.ok) {
    let errorText = "";

    try {
      errorText = await cozeResponse.text();
    } catch (error) {
      errorText = `读取 Coze 错误响应失败：${error.message}`;
    }

    console.error(
      `[${requestId}] Coze API 返回非 2xx：status=${cozeResponse.status}, body=${sanitizeText(errorText)}`
    );

    return sendError(
      res,
      502,
      `Coze API 返回异常状态：${cozeResponse.status}`,
      errorText || cozeResponse.statusText
    );
  }

  try {
    const result = await readCozeStream(cozeResponse);

    res.json({
      success: true,
      request_id: requestId,
      coze_status: cozeResponse.status,
      result
    });
  } catch (error) {
    console.error(`[${requestId}] Coze 流式响应读取失败：${sanitizeText(error.message)}`);
    return sendError(res, 502, "Coze 流式响应读取失败", error.message);
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "接口不存在",
    detail: `未找到路径：${req.method} ${req.path}`
  });
});

app.use((error, req, res, next) => {
  console.error(`服务端未处理异常：${sanitizeText(error.message)}`);
  res.status(500).json({
    success: false,
    message: "服务端内部错误",
    detail: "请查看服务端日志定位问题"
  });
});

function startServer() {
  return app.listen(PORT, () => {
    const missingKeys = getMissingEnvKeys();

    console.log(`${SERVICE_NAME} is running at http://localhost:${PORT}`);
    console.log(`Coze API Base: ${process.env.COZE_API_BASE || "https://api.coze.cn"}`);
    console.log(`Coze Workflow ID: ${maskSecret(process.env.COZE_WORKFLOW_ID)}`);

    if (missingKeys.length > 0) {
      console.warn(`配置提醒：缺少必要环境变量：${missingKeys.join(", ")}`);
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  ALLOWED_INPUT_PLATFORMS,
  ALLOWED_OUTPUT_PLATFORMS,
  app,
  startServer,
  validateWorkflowInput
};
