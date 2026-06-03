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

function createSseStreamParser(onEvent) {
  let pendingLine = "";
  let currentEvent = {
    event: "",
    dataLines: []
  };

  function emitCurrentEvent() {
    const events = [];
    pushSseEvent(events, currentEvent);
    currentEvent = {
      event: "",
      dataLines: []
    };

    for (const event of events) {
      onEvent(event);
    }
  }

  function processLine(rawLine) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.trim() === "") {
      emitCurrentEvent();
      return;
    }

    if (line.startsWith(":")) {
      return;
    }

    if (line.startsWith("event:")) {
      currentEvent.event = line.slice("event:".length).trim();
      return;
    }

    if (line.startsWith("data:")) {
      currentEvent.dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  return {
    push(chunk) {
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() || "";

      for (const line of lines) {
        processLine(line);
      }
    },

    flush() {
      if (pendingLine) {
        processLine(pendingLine);
        pendingLine = "";
      }

      emitCurrentEvent();
    }
  };
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
    hasInterrupt: false,
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

    if (eventName === "INTERRUPT") {
      meta.hasInterrupt = true;
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

function buildWorkflowResult(rawText, events = parseSseEvents(rawText)) {
  return {
    rawText,
    events,
    parsedText: extractParsedText(events),
    meta: extractStreamMeta(events)
  };
}

function getNodeTitle(data, fallback) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return fallback || "";
  }

  const value = data.node_title || data.nodeTitle || data.node_name || data.nodeName || "";
  return value ? String(value) : fallback || "";
}

function isNodeFinished(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }

  return data.node_is_finish === true || data.nodeIsFinish === true;
}

function createProgressTracker(options = {}) {
  const startedAt = options.startedAt || Date.now();
  const now = options.now || Date.now;
  let eventCount = 0;
  let latestNodeTitle = "";

  function createProgress(phase, label, eventName, nodeTitle) {
    return {
      type: "progress",
      phase,
      label,
      nodeTitle: nodeTitle || latestNodeTitle || "",
      eventName,
      eventCount,
      elapsedMs: Math.max(0, now() - startedAt)
    };
  }

  return {
    createProgress,

    updateFromSseEvent(item) {
      eventCount += 1;

      const eventName = item.event || "";
      const upperEventName = String(eventName).toUpperCase();
      const nodeTitle = getNodeTitle(item.data, latestNodeTitle);

      if (nodeTitle) {
        latestNodeTitle = nodeTitle;
      }

      if (upperEventName === "DONE") {
        return createProgress("completed", "工作流完成", eventName, nodeTitle);
      }

      if (upperEventName === "ERROR") {
        return createProgress("error", "工作流返回错误", eventName, nodeTitle);
      }

      if (upperEventName === "INTERRUPT") {
        return createProgress("interrupted", "工作流已中断", eventName, nodeTitle);
      }

      if (upperEventName === "PING") {
        const label = latestNodeTitle
          ? `正在执行：${latestNodeTitle}`
          : "已连接 Coze，正在等待工作流事件";
        return createProgress("waiting", label, eventName, nodeTitle);
      }

      if (nodeTitle) {
        const finished = isNodeFinished(item.data);
        return createProgress(
          finished ? "node_done" : "running",
          `${finished ? "已完成" : "正在执行"}：${nodeTitle}`,
          eventName,
          nodeTitle
        );
      }

      return createProgress("running", "收到工作流事件", eventName, nodeTitle);
    }
  };
}

module.exports = {
  buildWorkflowResult,
  createProgressTracker,
  createSseStreamParser,
  extractParsedText,
  extractStreamMeta,
  parseSseEvents
};
