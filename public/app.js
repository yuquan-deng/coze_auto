(function () {
  const form = document.getElementById("workflowForm");
  const submitButton = document.getElementById("submitButton");
  const statusBadge = document.getElementById("statusBadge");
  const progressPanel = document.getElementById("progressPanel");
  const progressPhase = document.getElementById("progressPhase");
  const progressLabel = document.getElementById("progressLabel");
  const progressNode = document.getElementById("progressNode");
  const progressEventCount = document.getElementById("progressEventCount");
  const progressElapsed = document.getElementById("progressElapsed");
  const parsedResult = document.getElementById("parsedResult");
  const urlInput = document.getElementById("url");
  const clearUrlButton = document.getElementById("clearUrlButton");

  const phaseLabels = {
    idle: "等待运行",
    submitting: "提交中",
    connected: "已连接",
    waiting: "等待事件",
    running: "运行中",
    node_done: "节点完成",
    completed: "已完成",
    error: "失败",
    interrupted: "已中断"
  };

  function setStatus(text, type) {
    statusBadge.textContent = text;
    statusBadge.className = `status-badge ${type}`;
  }

  function setLoading(isLoading) {
    submitButton.disabled = isLoading;
    submitButton.textContent = isLoading ? "正在运行..." : "运行工作流";
  }

  function resizeUrlInput() {
    urlInput.style.height = "auto";
    urlInput.style.height = `${urlInput.scrollHeight}px`;
  }

  function syncUrlInputControls() {
    clearUrlButton.hidden = !urlInput.value;
    resizeUrlInput();
  }

  function trimTrailingUrlPunctuation(url) {
    const match = url.match(/[。！？、，；：,.!?;:)）】\]]+$/);

    if (!match) {
      return {
        href: url,
        trailingText: ""
      };
    }

    return {
      href: url.slice(0, -match[0].length),
      trailingText: match[0]
    };
  }

  function appendLinkedText(element, text) {
    const urlPattern = /https?:\/\/[^\s<>"']+/g;
    let currentIndex = 0;
    let match;

    while ((match = urlPattern.exec(text)) !== null) {
      if (match.index > currentIndex) {
        element.appendChild(document.createTextNode(text.slice(currentIndex, match.index)));
      }

      const { href, trailingText } = trimTrailingUrlPunctuation(match[0]);

      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = href;
        element.appendChild(link);
      }

      if (trailingText) {
        element.appendChild(document.createTextNode(trailingText));
      }

      currentIndex = match.index + match[0].length;
    }

    if (currentIndex < text.length) {
      element.appendChild(document.createTextNode(text.slice(currentIndex)));
    }
  }

  function setLinkedPreContent(element, content, emptyText) {
    const hasContent = Boolean(content);
    const text = hasContent ? String(content) : emptyText;

    element.textContent = "";
    appendLinkedText(element, text);
    element.classList.toggle("empty", !hasContent);
  }

  function formatElapsed(elapsedMs) {
    const value = Number(elapsedMs);

    if (!Number.isFinite(value) || value <= 0) {
      return "-";
    }

    if (value < 1000) {
      return `${Math.round(value)}ms`;
    }

    if (value < 60000) {
      return `${(value / 1000).toFixed(1)}s`;
    }

    const minutes = Math.floor(value / 60000);
    const seconds = Math.round((value % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  function getProgressTone(phase) {
    if (phase === "completed" || phase === "node_done") {
      return "success";
    }

    if (phase === "error" || phase === "interrupted") {
      return "error";
    }

    if (phase === "idle") {
      return "idle";
    }

    return "active";
  }

  function setProgress(progress) {
    const phase = progress.phase || "idle";
    const tone = getProgressTone(phase);

    progressPanel.className = `progress-panel ${tone}`;
    progressPhase.textContent = phaseLabels[phase] || phase;
    progressLabel.textContent = progress.label || "等待运行";
    progressNode.textContent = progress.nodeTitle || "-";
    progressEventCount.textContent = String(progress.eventCount || 0);
    progressElapsed.textContent = formatElapsed(progress.elapsedMs);
  }

  function resetProgress() {
    setProgress({
      phase: "idle",
      label: "等待运行",
      nodeTitle: "",
      eventCount: 0,
      elapsedMs: 0
    });
  }

  function getPayload() {
    const formData = new FormData(form);

    return {
      platform_in: formData.get("platform_in"),
      platform_out: formData.get("platform_out"),
      url: String(formData.get("url") || "").trim(),
      prompt: String(formData.get("prompt") || "")
    };
  }

  function buildParsedText(result) {
    const meta = result.meta || {};
    let parsedText = result.parsedText || "";

    if (meta.hasError) {
      return [
        "工作流返回了错误事件。",
        meta.errorCode && `错误码：${meta.errorCode}`,
        meta.errorMessage && `错误信息：${meta.errorMessage}`,
        meta.debugUrl && `Coze 调试链接：${meta.debugUrl}`
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (!parsedText && meta.hasDone) {
      parsedText = "工作流已执行完成，但结束节点没有返回文本。";

      if (meta.debugUrl) {
        parsedText += `\nCoze 调试链接：${meta.debugUrl}`;
      }

      parsedText += "\n如果工作流已经写入公众号草稿箱，请到公众号后台确认草稿。";
    }

    return parsedText;
  }

  function renderWorkflowResult(result) {
    const parsedText = buildParsedText(result);

    setLinkedPreContent(parsedResult, parsedText, "未解析到文本，请检查工作流输出。");
  }

  function renderErrorText(message) {
    setLinkedPreContent(parsedResult, message, "请求发生异常");
  }

  async function readNdjsonStream(response, onEvent) {
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      throw new Error(text || "当前浏览器不支持读取流式响应");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed) {
          onEvent(JSON.parse(trimmed));
        }
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      onEvent(JSON.parse(buffer.trim()));
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    setStatus("正在调用工作流...", "loading");
    setProgress({
      phase: "submitting",
      label: "正在提交请求",
      nodeTitle: "",
      eventCount: 0,
      elapsedMs: 0
    });
    setLoading(true);
    setLinkedPreContent(parsedResult, "", "暂无结果");

    try {
      const response = await fetch("/api/run-workflow-stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(getPayload())
      });

      let terminalEventSeen = false;
      let latestProgress = null;

      await readNdjsonStream(response, (streamEvent) => {
        if (streamEvent.type === "progress") {
          latestProgress = streamEvent;
          setProgress(streamEvent);
          return;
        }

        if (streamEvent.type === "complete") {
          terminalEventSeen = true;
          setStatus("调用成功", "success");
          setProgress({
            phase: "completed",
            label: "工作流完成",
            nodeTitle: latestProgress?.nodeTitle || "",
            eventCount: latestProgress?.eventCount || streamEvent.result?.events?.length || 0,
            elapsedMs: latestProgress?.elapsedMs || 0
          });
          renderWorkflowResult(streamEvent.result || {});
          return;
        }

        if (streamEvent.type === "error") {
          const phase = streamEvent.message === "工作流已中断" ? "interrupted" : "error";

          terminalEventSeen = true;
          setStatus("调用失败", "error");
          setProgress({
            phase,
            label: streamEvent.message || "调用失败",
            nodeTitle: latestProgress?.nodeTitle || "",
            eventCount: latestProgress?.eventCount || streamEvent.result?.events?.length || 0,
            elapsedMs: streamEvent.elapsedMs || latestProgress?.elapsedMs || 0
          });
          if (streamEvent.result) {
            renderWorkflowResult(streamEvent.result);
          } else {
            renderErrorText([streamEvent.message, streamEvent.detail].filter(Boolean).join("\n"));
          }
        }
      });

      if (!terminalEventSeen) {
        setStatus("调用失败", "error");
        setProgress({
          phase: "error",
          label: "流式响应提前结束",
          nodeTitle: "",
          eventCount: 0,
          elapsedMs: 0
        });
        renderErrorText(
          response.ok
            ? "流式响应结束，但没有收到完成事件。"
            : `请求失败，HTTP 状态码：${response.status}`
        );
      }
    } catch (error) {
      setStatus("调用失败", "error");
      setProgress({
        phase: "error",
        label: "请求发生异常",
        nodeTitle: "",
        eventCount: 0,
        elapsedMs: 0
      });
      renderErrorText(error.message || "请求发生异常");
    } finally {
      setLoading(false);
    }
  });

  urlInput.addEventListener("input", syncUrlInputControls);
  clearUrlButton.addEventListener("click", () => {
    urlInput.value = "";
    syncUrlInputControls();
    urlInput.focus();
  });

  resetProgress();
  syncUrlInputControls();
})();
