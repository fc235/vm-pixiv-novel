# Pixiv Novel Extractor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-file Tampermonkey userscript that extracts a Pixiv novel or its complete series as readable text and either copies or downloads it.

**Architecture:** Keep the distributable in `pixiv-novel-extractor.user.js`, with pure transformation and formatting functions separated from Pixiv request adapters, export actions, and UI bootstrap inside one IIFE. In Node, guarded CommonJS exports expose pure and adapter functions for built-in `node:test` tests; in the browser, the same file initializes the userscript.

**Tech Stack:** JavaScript ES2020, Tampermonkey APIs (`GM_registerMenuCommand`, `GM_setClipboard`, `GM_download`), Pixiv same-origin AJAX responses, Node.js built-in test runner.

## Global Constraints

- Run only on `https://www.pixiv.net/novel/show.php?id=*`.
- Deliver one installable userscript file; test and documentation files are development-only.
- Support current novel and complete containing series, with both clipboard and UTF-8 `.txt` output.
- Convert Pixiv ruby, chapter, page, jump, and image markers to readable plain text.
- Never bypass Pixiv access controls or send novel/user data outside Pixiv.
- Fetch series entries sequentially with a short delay and continue past individual failures.
- Do not add EPUB, Markdown, image downloading, or unrelated configuration.

---

### Task 1: Project Harness and Pure Text Conversion

**Files:**
- Create: `package.json`
- Create: `pixiv-novel-extractor.user.js`
- Create: `tests/pixiv-novel-extractor.test.cjs`

**Interfaces:**
- Consumes: raw Pixiv novel text strings and page URLs.
- Produces: `parseNovelId(url): string|null`, `convertPixivText(raw): string`, `sanitizeFilename(name): string`, `formatNovel(novel): string`, and `formatSeries(title, results): string`.

- [ ] **Step 1: Add the failing core tests and test command**

Create `package.json`:

```json
{
  "name": "pixiv-novel-extractor-userscript",
  "private": true,
  "scripts": { "test": "node --test" }
}
```

Create `tests/pixiv-novel-extractor.test.cjs` with tests for the public pure API:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../pixiv-novel-extractor.user.js');

test('parses only Pixiv novel detail IDs', () => {
  assert.equal(core.parseNovelId('https://www.pixiv.net/novel/show.php?id=12345'), '12345');
  assert.equal(core.parseNovelId('https://www.pixiv.net/artworks/12345'), null);
});

test('converts Pixiv markers to readable text', () => {
  const raw = '[chapter:序章]\n[[rb:漢字 > かんじ]][newpage][jump:3][pixivimage:42]';
  assert.equal(core.convertPixivText(raw), '序章\n\n漢字（かんじ）\n\n[跳转至第 3 页]\n[插图：Pixiv 作品 42]');
});

test('preserves paragraphs while normalizing line endings and excess blanks', () => {
  assert.equal(core.convertPixivText('甲\r\n\r\n\r\n乙  \r\n'), '甲\n\n乙');
});

test('sanitizes Windows filenames', () => {
  assert.equal(core.sanitizeFilename('A/B:*?"<>|. '), 'A_B________');
  assert.equal(core.sanitizeFilename('   '), 'pixiv-novel');
  assert.ok(core.sanitizeFilename('文'.repeat(200)).length <= 120);
});

test('formats a single novel and a partly failed series', () => {
  assert.equal(core.formatNovel({ title: '标题', text: '正文' }), '标题\n\n正文');
  assert.equal(
    core.formatSeries('系列', [
      { ok: true, novel: { title: '第一章', text: '甲' } },
      { ok: false, id: '2', error: '无权访问' }
    ]),
    '系列\n\n===== 第 1 篇：第一章 =====\n\n甲\n\n===== 第 2 篇：作品 2 =====\n\n[提取失败：无权访问]'
  );
});
```

- [ ] **Step 2: Run the tests and confirm the missing-module failure**

Run: `npm test`

Expected: FAIL because `pixiv-novel-extractor.user.js` does not exist or does not export the tested functions.

- [ ] **Step 3: Implement the minimal userscript shell and pure functions**

Create `pixiv-novel-extractor.user.js` with the Tampermonkey metadata (`@name`, `@namespace`, `@version`, `@description`, `@match`, `@grant` entries for the three GM functions, and `@run-at document-idle`). Add an IIFE containing these complete behaviors:

```js
const parseNovelId = (url) => {
  const parsed = new URL(url);
  return parsed.hostname === 'www.pixiv.net' && parsed.pathname === '/novel/show.php'
    ? parsed.searchParams.get('id')?.match(/^\d+$/)?.[0] ?? null
    : null;
};

const convertPixivText = (raw) => String(raw ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/\[\[rb:([^\]>]+?)\s*>\s*([^\]]+?)\]\]/g, '$1（$2）')
  .replace(/\[chapter:([^\]]+)]/g, '\n\n$1\n\n')
  .replace(/\[newpage]/g, '\n\n')
  .replace(/\[jump:(\d+)]/g, '\n[跳转至第 $1 页]\n')
  .replace(/\[pixivimage:(\d+)]/g, '\n[插图：Pixiv 作品 $1]\n')
  .split('\n').map((line) => line.trimEnd()).join('\n')
  .replace(/\n{3,}/g, '\n\n').trim();

const sanitizeFilename = (name) => {
  const cleaned = String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim().replace(/[. ]+$/g, '');
  return (cleaned || 'pixiv-novel').slice(0, 120);
};

const formatNovel = ({ title, text }) => `${title}\n\n${text}`;
const formatSeries = (title, results) => [title, ...results.map((item, index) => {
  const itemTitle = item.ok ? item.novel.title : `作品 ${item.id}`;
  const body = item.ok ? item.novel.text : `[提取失败：${item.error}]`;
  return `===== 第 ${index + 1} 篇：${itemTitle} =====\n\n${body}`;
})].join('\n\n');
```

Export the functions when `module.exports` exists; do not bootstrap in that branch. Leave an empty `bootstrap()` call for the browser branch.

- [ ] **Step 4: Run core tests**

Run: `npm test`

Expected: 5 tests PASS.

- [ ] **Step 5: Commit the core**

```powershell
git add -- package.json pixiv-novel-extractor.user.js tests/pixiv-novel-extractor.test.cjs
git commit -m "feat: add Pixiv text conversion core"
```

---

### Task 2: Pixiv Data Adapter and Series Pagination

**Files:**
- Modify: `pixiv-novel-extractor.user.js`
- Modify: `tests/pixiv-novel-extractor.test.cjs`

**Interfaces:**
- Consumes: `requestJson(url): Promise<object>` dependency and novel/series IDs.
- Produces: `createPixivClient(requestJson, delay)` returning `getNovel(id)`, `getSeriesInfo(seriesId)`, `getSeriesEntries(seriesId)`, and `getWholeSeries(seedNovel, onProgress)`.
- `getNovel` resolves `{ id, title, text, series: null|{ id, title } }`.
- `getWholeSeries` resolves `{ title, results, successCount, failureCount }`.

- [ ] **Step 1: Add failing adapter tests**

Append tests using a fake request function. Cover:

```js
test('maps a Pixiv novel response', async () => {
  const client = core.createPixivClient(async () => ({ error: false, body: {
    id: '10', title: '原题', content: '[[rb:字 > じ]]',
    seriesNavData: { seriesId: '7', title: '系列名' }
  }}), async () => {});
  assert.deepEqual(await client.getNovel('10'), {
    id: '10', title: '原题', text: '字（じ）', series: { id: '7', title: '系列名' }
  });
});

test('paginates series content by last order without duplicates', async () => {
  const urls = [];
  const client = core.createPixivClient(async (url) => {
    urls.push(url);
    return urls.length === 1
      ? { error: false, body: { seriesContents: [{ id: '10', series: { order: 1 } }, { id: '11', series: { order: 2 } }], total: 3 } }
      : { error: false, body: { seriesContents: [{ id: '12', series: { order: 3 } }], total: 3 } };
  }, async () => {});
  assert.deepEqual((await client.getSeriesEntries('7')).map((x) => x.id), ['10', '11', '12']);
  assert.match(urls[1], /last_order=2/);
});

test('continues a series after one novel fails and reports progress', async () => {
  const progress = [];
  const client = core.createPixivClient(async (url) => {
    if (url.includes('series_content')) return { error: false, body: { seriesContents: [{ id: '1', series: { order: 1 } }, { id: '2', series: { order: 2 } }], total: 2 } };
    if (url.includes('/2?')) return { error: true, message: '无权访问' };
    return { error: false, body: { id: '1', title: '一', content: '正文', seriesNavData: { seriesId: '7', title: '系列' } } };
  }, async () => {});
  const result = await client.getWholeSeries({ series: { id: '7', title: '系列' } }, (done, total) => progress.push([done, total]));
  assert.equal(result.successCount, 1);
  assert.equal(result.failureCount, 1);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
});
```

- [ ] **Step 2: Run adapter tests and verify failure**

Run: `npm test`

Expected: FAIL because `createPixivClient` is not exported.

- [ ] **Step 3: Implement the adapter**

Implement `createPixivClient` with:

- `getNovel(id)` requesting `/ajax/novel/${id}?lang=zh`, rejecting `error: true` and missing `body.content`, and running `convertPixivText`.
- `getSeriesInfo(seriesId)` requesting `/ajax/novel/series/${seriesId}?lang=zh` and returning its body.
- `getSeriesEntries(seriesId)` requesting `/ajax/novel/series_content/${seriesId}?limit=30&last_order=${lastOrder}&order_by=asc&lang=zh` until collected unique IDs reach `body.total` or a page is empty. Sort by numeric `entry.series.order`.
- A repeated-page guard that throws `系列分页没有继续前进` when the last order does not increase.
- `getWholeSeries(seedNovel, onProgress)` processing entries in order, catching per-entry errors, invoking `onProgress(done, total)` after every entry, and awaiting the injected `delay(350)` between entries except after the last.

Validate IDs with `/^\d+$/` before interpolating URLs. Convert thrown values into concise messages with `error instanceof Error ? error.message : String(error)`.

- [ ] **Step 4: Run all tests**

Run: `npm test`

Expected: 8 tests PASS.

- [ ] **Step 5: Commit the adapter**

```powershell
git add -- pixiv-novel-extractor.user.js tests/pixiv-novel-extractor.test.cjs
git commit -m "feat: add Pixiv novel and series adapter"
```

---

### Task 3: DOM Fallback and Export Actions

**Files:**
- Modify: `pixiv-novel-extractor.user.js`
- Modify: `tests/pixiv-novel-extractor.test.cjs`

**Interfaces:**
- Consumes: browser `document`, `GM_setClipboard`, `GM_download`, `Blob`, and `URL` dependencies.
- Produces: `extractNovelFromDocument(doc, id)`, `copyText(text, clipboard)`, and `downloadText(title, text, environment)`.

- [ ] **Step 1: Add failing DOM/export tests**

Use small fake document objects rather than adding jsdom:

```js
test('extracts title and rendered paragraphs from DOM fallback', () => {
  const nodes = { 'main h1': { textContent: '标题' }, '[data-testid="novel-text"]': { innerText: '第一段\n\n第二段' } };
  const doc = { querySelector: (selector) => nodes[selector] ?? null };
  assert.deepEqual(core.extractNovelFromDocument(doc, '9'), { id: '9', title: '标题', text: '第一段\n\n第二段', series: null });
});

test('rejects an incomplete DOM fallback', () => {
  assert.throws(() => core.extractNovelFromDocument({ querySelector: () => null }, '9'), /页面正文/);
});

test('copyText passes the plain text MIME type', async () => {
  const calls = [];
  await core.copyText('内容', (...args) => calls.push(args));
  assert.deepEqual(calls, [['内容', 'text/plain']]);
});
```

For `downloadText`, inject fakes and assert the generated name ends in `.txt`, Blob type is `text/plain;charset=utf-8`, `GM_download` receives a blob URL, and `revokeObjectURL` is called after completion.

- [ ] **Step 2: Run tests and verify missing-function failures**

Run: `npm test`

Expected: FAIL on `extractNovelFromDocument`, `copyText`, and `downloadText`.

- [ ] **Step 3: Implement fallback and actions**

Implement DOM fallback with ordered selector lists:

```js
const first = (doc, selectors) => selectors.map((s) => doc.querySelector(s)).find(Boolean);
const titleNode = first(doc, ['main h1', 'h1']);
const textNode = first(doc, ['[data-testid="novel-text"]', 'main article', 'main [role="article"]']);
```

Require non-empty `textContent`/`innerText`, normalize it through `convertPixivText`, and return `series: null`. Implement `copyText` as a Promise-aware wrapper around `GM_setClipboard(text, 'text/plain')`. Implement `downloadText` using a UTF-8 Blob, `URL.createObjectURL`, `GM_download({ url, name, saveAs: true, onload, onerror })`, and revoke the URL in both callbacks. Reject with `下载失败` on the error callback.

- [ ] **Step 4: Run all tests**

Run: `npm test`

Expected: all core, adapter, DOM, and export tests PASS.

- [ ] **Step 5: Commit fallback and export actions**

```powershell
git add -- pixiv-novel-extractor.user.js tests/pixiv-novel-extractor.test.cjs
git commit -m "feat: add DOM fallback and text export"
```

---

### Task 4: Floating Panel, Menu Commands, and Browser Bootstrap

**Files:**
- Modify: `pixiv-novel-extractor.user.js`
- Modify: `tests/pixiv-novel-extractor.test.cjs`
- Create: `README.md`

**Interfaces:**
- Consumes: all earlier functions plus browser/Tampermonkey globals.
- Produces: `createController(deps)` with `loadCurrent()`, `copyCurrent()`, `downloadCurrent()`, `copySeries()`, and `downloadSeries()`; browser `bootstrap()` binds the four operations to the panel and menu.

- [ ] **Step 1: Add failing controller tests**

Inject fake client, fallback, copy, download, and status functions. Assert:

- `loadCurrent()` tries `client.getNovel(id)` first and uses DOM fallback only after failure.
- Current copy formats with `formatNovel` and reports `已复制当前小说`.
- Series actions reject with `当前作品不属于系列` when `series` is null.
- Series progress reports `正在提取系列：1 / 2`.
- Final partial success reports `系列提取完成：成功 1 篇，失败 1 篇`.

Use exact fake dependencies so no browser globals are accessed during Node tests.

- [ ] **Step 2: Run controller tests and verify failure**

Run: `npm test`

Expected: FAIL because `createController` does not exist.

- [ ] **Step 3: Implement controller and UI**

Implement `createController(deps)` as the only coordinator of extraction and actions. Cache the successfully loaded current novel for the page ID. For series export, call `getWholeSeries`, format once, then copy or download. Convert all errors to status text prefixed with `失败：` and re-enable controls in `finally`.

Implement `bootstrap()` to:

1. Parse `location.href`; return when there is no valid ID.
2. Create `requestJson` using same-origin `fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })`, requiring `response.ok` before `response.json()`.
3. Create the Pixiv client and controller.
4. Inject one shadow-DOM host with fixed bottom-right placement, a compact dark panel, four buttons, a status line with `aria-live="polite"`, and a collapse button.
5. Disable series buttons after the first loaded novel proves `series === null`; otherwise leave them enabled.
6. Disable all buttons while an action runs and restore applicable states afterward.
7. Register the same four labels through `GM_registerMenuCommand`.

Keep all styles inside the shadow root. Use text nodes/textContent for status and labels; never insert fetched Pixiv content via `innerHTML`.

- [ ] **Step 4: Add installation and usage documentation**

Create `README.md` documenting installation in Tampermonkey, the four commands, supported Pixiv URL, readable marker conversion, access-control limitations, and `npm test`. Explicitly state that series extraction is sequential and that no content is sent outside Pixiv.

- [ ] **Step 5: Run automated verification**

Run: `npm test`

Expected: all tests PASS with zero failures.

Run: `node --check pixiv-novel-extractor.user.js`

Expected: exit code 0 with no output.

Run: `rg -n "@match|@grant|GM_registerMenuCommand|GM_setClipboard|GM_download|series_content|data-testid" pixiv-novel-extractor.user.js`

Expected: metadata and each required integration point appear in the single userscript.

- [ ] **Step 6: Perform manual Pixiv verification**

Install the local script in Tampermonkey and check one accessible standalone novel and one accessible series novel:

- The panel appears only on a novel detail URL and does not obscure the reading area.
- Current copy and download include the exact title and full readable body.
- Standalone work disables series operations with the designed explanation.
- Series progress increases in order; final text follows series order.
- A blocked/deleted series entry becomes a failure placeholder while later entries continue.
- The downloaded file opens as UTF-8 and has a Windows-safe title.

If Pixiv's rendered body selector differs, inspect only the actual body container and add one precise selector to the ordered fallback list with a matching fake-document test.

- [ ] **Step 7: Commit the finished userscript**

```powershell
git add -- pixiv-novel-extractor.user.js tests/pixiv-novel-extractor.test.cjs README.md package.json
git commit -m "feat: complete Pixiv novel extractor userscript"
```

---

## Final Verification

- [ ] Run `npm test` and confirm zero failures.
- [ ] Run `node --check pixiv-novel-extractor.user.js` and confirm exit code 0.
- [ ] Run `git status --short` and confirm only intentional documentation/plan state remains.
- [ ] Compare the final behavior against every acceptance criterion in `docs/superpowers/specs/2026-09-01-pixiv-novel-extractor-design.md`.
