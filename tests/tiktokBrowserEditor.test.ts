import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preparePost, submitPost } from "../lib/tiktok/browser";
import type { TikTokJob } from "../lib/tiktok/state";

test("browser adapter fills caption/cover before Post and waits for success", async () => {
  const browser = await chromium.launch({ headless: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-tiktok-editor-"));
  try {
    const page = await browser.newPage();
    const video = path.join(root, "video.mp4"), cover = path.join(root, "cover.png");
    fs.writeFileSync(video, "test fixture video"); fs.writeFileSync(cover, "test fixture image");
    const job: TikTokJob = { id: "1", key: "key", projectId: "p", account: "a", video, cover, caption: "A title\n\nA caption #tag", scheduledAt: "", at: "", status: "running", message: "" };
    await page.route("https://www.tiktok.com/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>
      <input type="file" accept="video/mp4" />
      <div role="textbox" contenteditable="true"></div>
      <button onclick="document.querySelector('[role=dialog]').hidden=false">Edit cover</button>
      <div role="dialog" hidden><input type="file" accept="image/*" /><button onclick="document.body.dataset.cover='saved';this.parentElement.hidden=true">Save</button></div>
      <span>Everyone</span>
      <button onclick="document.body.dataset.posted='yes';document.querySelector('#result').hidden=false">Post</button>
      <div id="result" hidden>Your video has been published <a href="/@owner/video/123456">View video</a></div>
    </body></html>` }));
    await preparePost(page, job);
    assert.deepEqual((await page.locator('[role="textbox"]').innerText()).split(/\n+/), ["A title", "A caption #tag"]);
    assert.equal(await page.locator("body").getAttribute("data-cover"), "saved");
    assert.equal(await page.locator("body").getAttribute("data-posted"), null);
    assert.equal(await submitPost(page), "https://www.tiktok.com/@owner/video/123456");
    assert.equal(await page.locator("body").getAttribute("data-posted"), "yes");
  } finally {
    await browser.close();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("gudini-tiktok-editor-")) throw new Error("Invalid cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported visibility stops before public submission", async () => {
  const browser = await chromium.launch({ headless: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-tiktok-editor-"));
  try {
    const page = await browser.newPage();
    const video = path.join(root, "video.mp4"); fs.writeFileSync(video, "fixture");
    await page.route("https://www.tiktok.com/**", route => route.fulfill({ contentType: "text/html", body: '<input type="file" accept="video/mp4" /><div contenteditable="true" role="textbox"></div><span>Only me</span><button onclick="document.body.dataset.posted=1">Post</button>' }));
    await assert.rejects(preparePost(page, { id: "x", key: "x", projectId: "p", account: "a", video, caption: "Caption", scheduledAt: "", at: "", status: "running", message: "" }), /видимость/);
    assert.equal(await page.locator("body").getAttribute("data-posted"), null);
  } finally {
    await browser.close();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("gudini-tiktok-editor-")) throw new Error("Invalid cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
