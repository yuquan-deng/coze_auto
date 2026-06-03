const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");
const indexHtmlPath = path.join(projectRoot, "public", "index.html");
const stylesPath = path.join(projectRoot, "public", "styles.css");
const appJsPath = path.join(projectRoot, "public", "app.js");

function createFakeElement(id) {
  return {
    id,
    value: "",
    hidden: false,
    scrollHeight: 96,
    style: {},
    textContent: "",
    className: "",
    listeners: {},
    classList: {
      toggle() {}
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    appendChild() {},
    focus() {
      this.focused = true;
    }
  };
}

function runAppScriptWithFakeDom() {
  const ids = [
    "workflowForm",
    "submitButton",
    "statusBadge",
    "progressPanel",
    "progressPhase",
    "progressLabel",
    "progressNode",
    "progressEventCount",
    "progressElapsed",
    "parsedResult",
    "url",
    "clearUrlButton"
  ];
  const elements = new Map(ids.map((id) => [id, createFakeElement(id)]));
  const source = fs.readFileSync(appJsPath, "utf8");

  vm.runInNewContext(source, {
    document: {
      getElementById(id) {
        return elements.get(id);
      },
      createElement(tagName) {
        return createFakeElement(tagName);
      },
      createTextNode(text) {
        return { textContent: text };
      }
    },
    FormData: class FormData {},
    TextDecoder,
    fetch() {
      throw new Error("fetch should not run in this test");
    }
  });

  return elements;
}

test("content link field uses an expanding textarea with a clear button", () => {
  const html = fs.readFileSync(indexHtmlPath, "utf8");
  const css = fs.readFileSync(stylesPath, "utf8");

  assert.match(html, /<textarea[\s\S]*id="url"[\s\S]*name="url"[\s\S]*required[\s\S]*><\/textarea>/);
  assert.match(html, /id="clearUrlButton"/);
  assert.match(html, /aria-label="清空内容链接"/);
  assert.match(css, /\.url-input-wrap/);
  assert.match(css, /#url[\s\S]*min-height:\s*72px/);
  assert.match(css, /#prompt[\s\S]*\n\s*height:\s*88px/);
});

test("content link textarea expands and the clear button clears only the url field", () => {
  const elements = runAppScriptWithFakeDom();
  const urlInput = elements.get("url");
  const clearUrlButton = elements.get("clearUrlButton");

  assert.equal(clearUrlButton.hidden, true);
  assert.equal(typeof urlInput.listeners.input, "function");
  assert.equal(typeof clearUrlButton.listeners.click, "function");

  urlInput.value = "https://example.com/very/long/article/link";
  urlInput.scrollHeight = 168;
  urlInput.listeners.input();

  assert.equal(clearUrlButton.hidden, false);
  assert.equal(urlInput.style.height, "168px");

  clearUrlButton.listeners.click();

  assert.equal(urlInput.value, "");
  assert.equal(clearUrlButton.hidden, true);
  assert.equal(urlInput.focused, true);
});
