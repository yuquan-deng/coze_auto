const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildWorkflowResult,
  createProgressTracker,
  createSseStreamParser
} = require("../lib/workflow-stream");

test("createSseStreamParser emits SSE events across chunk boundaries", () => {
  const events = [];
  const parser = createSseStreamParser((event) => events.push(event));

  parser.push('event: Message\n');
  parser.push('data: {"node_title":"采集内容","node_is_finish":false,"content":"开始采集"}\n\n');
  parser.flush();

  assert.deepEqual(events, [
    {
      event: "Message",
      data: {
        node_title: "采集内容",
        node_is_finish: false,
        content: "开始采集"
      },
      rawData: '{"node_title":"采集内容","node_is_finish":false,"content":"开始采集"}'
    }
  ]);
});

test("createProgressTracker describes running and finished workflow nodes", () => {
  const tracker = createProgressTracker({
    startedAt: 1000,
    now: () => 1750
  });

  const running = tracker.updateFromSseEvent({
    event: "Message",
    data: {
      node_title: "采集内容",
      node_is_finish: false
    }
  });

  assert.deepEqual(running, {
    type: "progress",
    phase: "running",
    label: "正在执行：采集内容",
    nodeTitle: "采集内容",
    eventName: "Message",
    eventCount: 1,
    elapsedMs: 750
  });

  const finished = tracker.updateFromSseEvent({
    event: "Message",
    data: {
      node_title: "采集内容",
      node_is_finish: true
    }
  });

  assert.deepEqual(finished, {
    type: "progress",
    phase: "node_done",
    label: "已完成：采集内容",
    nodeTitle: "采集内容",
    eventName: "Message",
    eventCount: 2,
    elapsedMs: 750
  });
});

test("buildWorkflowResult extracts final text and stream metadata", () => {
  const rawText = [
    'event: Message\ndata: {"node_title":"生成文案","content":"第一段"}',
    "",
    'event: Message\ndata: {"node_title":"生成文案","content":"第二段"}',
    "",
    'event: Done\ndata: {"debug_url":"https://debug.example/run"}',
    "",
    ""
  ].join("\n");

  const result = buildWorkflowResult(rawText);

  assert.equal(result.parsedText, "第一段\n第二段");
  assert.equal(result.meta.hasDone, true);
  assert.equal(result.meta.hasError, false);
  assert.equal(result.meta.debugUrl, "https://debug.example/run");
  assert.equal(result.events.length, 3);
});
