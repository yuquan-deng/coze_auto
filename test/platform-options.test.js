const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const projectRoot = path.join(__dirname, "..");
const indexHtmlPath = path.join(projectRoot, "public", "index.html");
const serverPath = path.join(projectRoot, "server.js");

function getSelectOptionValues(html, selectId) {
  const selectMatch = html.match(new RegExp(`<select[^>]+id="${selectId}"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(selectMatch, `Expected to find select#${selectId}`);

  return [...selectMatch[1].matchAll(/<option\s+value="([^"]+)"/g)].map((match) => match[1]);
}

function loadServerModule() {
  const source = fs.readFileSync(serverPath, "utf8");
  const serverRequire = createRequire(serverPath);
  const app = {
    get() {},
    listen() {
      return { close() {} };
    },
    post() {},
    use() {}
  };
  const express = Object.assign(() => app, {
    json: () => () => {},
    static: () => () => {}
  });
  const sandboxRequire = (request) => {
    if (request === "express") {
      return express;
    }

    if (request === "dotenv") {
      return { config() {} };
    }

    return serverRequire(request);
  };
  sandboxRequire.main = {};

  const sandbox = {
    __dirname: projectRoot,
    console,
    module: { exports: {} },
    process: { env: {} },
    require: sandboxRequire,
    TextDecoder
  };

  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(source, sandbox, { filename: serverPath });

  return sandbox.module.exports;
}

test("output platform dropdown only offers 公众号 and 小红书", () => {
  const html = fs.readFileSync(indexHtmlPath, "utf8");

  assert.deepEqual(getSelectOptionValues(html, "platform_out"), ["公众号", "小红书"]);
});

test("input platform dropdown still offers 抖音", () => {
  const html = fs.readFileSync(indexHtmlPath, "utf8");

  assert.deepEqual(getSelectOptionValues(html, "platform_in"), ["小红书", "公众号", "抖音"]);
});

test("page shows workflow usage notices", () => {
  const html = fs.readFileSync(indexHtmlPath, "utf8");

  assert.match(html, /注意事项/);
  assert.match(html, /输入的小红书链接必须是网页版的链接/);
  assert.match(html, /公众号→小红书2min左右/);
  assert.match(html, /可直接用生成的二维码导入/);
});

test("page only exposes the parsed result panel", () => {
  const html = fs.readFileSync(indexHtmlPath, "utf8");

  assert.match(html, /解析结果/);
  assert.match(html, /id="parsedResult"/);
  assert.doesNotMatch(html, /原始返回/);
  assert.doesNotMatch(html, /id="rawResult"/);
  assert.doesNotMatch(html, /id="errorBox"/);
});

test("workflow validation rejects 抖音 as an output platform", () => {
  const { validateWorkflowInput } = loadServerModule();

  assert.equal(typeof validateWorkflowInput, "function");

  const result = validateWorkflowInput({
    platform_in: "抖音",
    platform_out: "抖音",
    url: "https://example.com/article"
  });

  assert.equal(result.ok, false);
  assert.equal(result.message, "platform_out 参数不合法");
  assert.equal(result.detail, "platform_out 必须是以下之一：公众号、小红书");
});
