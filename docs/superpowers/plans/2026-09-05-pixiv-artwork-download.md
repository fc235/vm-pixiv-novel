# Pixiv Artwork Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the userscript so a Pixiv artwork page downloads one original image directly or packages a multi-page work into a ZIP using the agreed retry and 20% failure policy.

**Architecture:** Keep one distributable userscript. Add separately testable artwork parsing/client, binary download/archive, artwork controller, and route-bootstrap units; make the existing panel data-driven so both page types share its UI and persisted minimize state.

**Tech Stack:** JavaScript ES2020, Tampermonkey APIs, Pixiv same-session AJAX, pinned JSZip 3.10.1, Node.js built-in test runner.

## Global Constraints

- Existing novel copy, current-novel download, series download, clipboard, and minimize behavior remain unchanged.
- Match `https://www.pixiv.net/artworks/*` and process only the current artwork's Pixiv-provided original pages.
- Single-page works download one original directly and never instantiate JSZip.
- Multi-page works use JSZip `STORE`, preserve Pixiv order, and name pages `001.jpg`, `002.png`, and so on.
- Each image gets exactly two attempts: the initial request plus one retry.
- Failure ratio exactly 20% produces a partial ZIP with UTF-8 `下载失败.txt`; once failures exceed 20% of total pages, stop and produce no ZIP.
- Single-image failure produces no file.
- Single filename: `[pixiv_ID] sanitized title.ext`; multi filename: `[pixiv_ID] sanitized title.zip`.
- Use a pinned JSZip 3.10.1 HTTPS URL, `GM_xmlhttpRequest`, and `@connect i.pximg.net` only.
- Download sequentially, process locally, and disclose large-work memory usage.
- Do not add author downloads, queues, settings, resume support, ugoira support, or access-control bypasses.
- Final userscript version is `0.3.0`.

---

## File Map

- Modify `pixiv-novel-extractor.user.js`: artwork data, download strategy, controller, shared panel configuration, routing, and metadata.
- Modify `tests/pixiv-novel-extractor.test.cjs`: unit/integration coverage plus all existing novel regressions.
- Modify `README.md`: install, usage, failure policy, privacy, and memory notes.

### Task 1: Parse and map artwork data

**Files:**
- Modify: `pixiv-novel-extractor.user.js:1-100`
- Test: `tests/pixiv-novel-extractor.test.cjs:1-60`

**Interfaces:**
- Produces `parseArtworkId(url): string|null`.
- Produces `imageExtension(url): string` and `formatPageFilename(index,total,url): string`.
- Produces `createArtworkClient(requestJson).getArtwork(id): Promise<{id,title,pages:[{index,url}]}>`.

- [ ] **Step 1: Write failing parsing and mapping tests**

```js
test('parses only Pixiv artwork IDs', () => {
  assert.equal(core.parseArtworkId('https://www.pixiv.net/artworks/12345'), '12345');
  assert.equal(core.parseArtworkId('https://www.pixiv.net/artworks/nope'), null);
  assert.equal(core.parseArtworkId('https://www.pixiv.net/novel/show.php?id=12345'), null);
});

test('formats original image page names', () => {
  assert.equal(core.imageExtension('https://i.pximg.net/42_p0.PNG?x=1'), 'png');
  assert.equal(core.imageExtension('https://example.test/file.svg'), 'jpg');
  assert.equal(core.formatPageFilename(0, 12, 'https://i.pximg.net/42_p0.jpg'), '001.jpg');
  assert.equal(core.formatPageFilename(11, 12, 'https://i.pximg.net/42_p11.webp'), '012.webp');
});

test('maps artwork originals in Pixiv order', async () => {
  const calls = [];
  const client = core.createArtworkClient(async (url) => {
    calls.push(url);
    return url.includes('/pages')
      ? { error: false, body: [
          { urls: { original: 'https://i.pximg.net/10_p0.jpg' } },
          { urls: { original: 'https://i.pximg.net/10_p1.png' } }
        ] }
      : { error: false, body: { id: '10', title: '作品名', illustType: 0 } };
  });
  assert.deepEqual(await client.getArtwork('10'), {
    id: '10', title: '作品名', pages: [
      { index: 0, url: 'https://i.pximg.net/10_p0.jpg' },
      { index: 1, url: 'https://i.pximg.net/10_p1.png' }
    ]
  });
  assert.deepEqual(calls, ['/ajax/illust/10?lang=zh', '/ajax/illust/10/pages?lang=zh']);
});

test('rejects missing originals and ugoira', async () => {
  const missing = core.createArtworkClient(async (url) => url.includes('/pages')
    ? { error: false, body: [{ urls: {} }] }
    : { error: false, body: { title: '作品', illustType: 0 } });
  const ugoira = core.createArtworkClient(async () => ({
    error: false, body: { title: '动图', illustType: 2 }
  }));
  await assert.rejects(missing.getArtwork('10'), /原图地址/);
  await assert.rejects(ugoira.getArtwork('10'), /动图作品暂不支持/);
});
```

- [ ] **Step 2: Run RED tests**

Run `node --test --test-name-pattern="artwork IDs|page names|maps artwork|ugoira" tests/pixiv-novel-extractor.test.cjs`.

Expected: four failures because these exports do not exist.

- [ ] **Step 3: Implement the helpers**

```js
const parseArtworkId = (url) => {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/artworks\/(\d+)\/?$/);
  return parsed.hostname === 'www.pixiv.net' ? match?.[1] ?? null : null;
};

const imageExtension = (url) => {
  try {
    const value = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(value) ? value : 'jpg';
  } catch (_error) { return 'jpg'; }
};

const formatPageFilename = (index, total, url) => (
  `${String(index + 1).padStart(Math.max(3, String(total).length), '0')}.${imageExtension(url)}`
);
```

- [ ] **Step 4: Implement and export the artwork client**

`getArtwork(id)` validates a numeric ID, requests `/ajax/illust/${id}?lang=zh` followed by `/ajax/illust/${id}/pages?lang=zh`, rejects `illustType === 2`, maps only `https://i.pximg.net/` `urls.original` values, rejects empty/missing pages, and returns the interface above. Use the existing `responseBody`, `requireNumericId`, and title fallback `作品 ${id}`.

- [ ] **Step 5: Add metadata capabilities**

```js
// @match        https://www.pixiv.net/artworks/*
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        GM_xmlhttpRequest
// @connect      i.pximg.net
```

Keep version `0.2.0` until Task 4.

- [ ] **Step 6: Verify and commit**

Run the Step 2 command, `npm test`, and `node --check pixiv-novel-extractor.user.js`; expect all green. Commit:

```powershell
git add pixiv-novel-extractor.user.js tests/pixiv-novel-extractor.test.cjs
git commit -m "feat: map Pixiv artwork originals"
```

### Task 2: Download originals and construct ZIPs

**Files:**
- Modify: `pixiv-novel-extractor.user.js:200-270`
- Test: `tests/pixiv-novel-extractor.test.cjs:190-300`

**Interfaces:**
- Produces `requestBinary(url,gmRequest): Promise<ArrayBuffer>`.
- Produces `downloadBlob(filename,blob,environment): Promise<void>`.
- Produces `createArtworkDownloader(deps).download(artwork,onProgress): Promise<{kind,successCount,failureCount}>`.

- [ ] **Step 1: Write failing binary adapter tests**

```js
test('requests image binary with Pixiv referer', async () => {
  let sent;
  const data = new ArrayBuffer(2);
  const result = await core.requestBinary('https://i.pximg.net/a.jpg', (options) => {
    sent = options;
    options.onload({ status: 200, response: data });
  });
  assert.equal(result, data);
  assert.equal(sent.method, 'GET');
  assert.equal(sent.responseType, 'arraybuffer');
  assert.equal(sent.headers.Referer, 'https://www.pixiv.net/');
});

test('rejects failed image responses', async () => {
  await assert.rejects(core.requestBinary('https://i.pximg.net/a.jpg', (options) => {
    options.onload({ status: 403, response: null });
  }), /HTTP 403/);
});
```

- [ ] **Step 2: Run binary tests RED**

Run `node --test --test-name-pattern="image binary|failed image responses" tests/pixiv-novel-extractor.test.cjs`.

Expected: failures because `requestBinary` is undefined.

- [ ] **Step 3: Implement binary and Blob download adapters**

`requestBinary` wraps `GM_xmlhttpRequest` with GET, `Referer: https://www.pixiv.net/`, `responseType: arraybuffer`, success status 200–299, and distinct HTTP/error/timeout errors. `downloadBlob` contains the existing Blob URL + `GM_download` lifecycle and revokes on success, error, or synchronous exception. Refactor `downloadText` to create its UTF-8 Blob and delegate to `downloadBlob`, preserving existing behavior.

- [ ] **Step 4: Write failing archive policy tests**

Add the fake and four policy tests:

```js
class FakeZip {
  constructor() {
    this.files = [];
    this.generateCalls = [];
  }
  file(name, data) {
    this.files.push([name, data]);
    return this;
  }
  async generateAsync(options, onUpdate) {
    this.generateCalls.push(options);
    onUpdate({ percent: 50 });
    return { zip: true };
  }
}

const artworkPages = (count) => Array.from({ length: count }, (_, index) => ({
  index,
  url: `https://i.pximg.net/10_p${index}.jpg`
}));

test('single artwork retries once and downloads without ZIP', async () => {
  let attempts = 0;
  let zipCalls = 0;
  const files = [];
  const downloader = core.createArtworkDownloader({
    requestBinary: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary');
      return new ArrayBuffer(1);
    },
    createZip: () => { zipCalls += 1; return new FakeZip(); },
    makeBlob: (parts, options) => ({ parts, type: options.type }),
    downloadFile: async (name, blob) => files.push([name, blob])
  });
  const result = await downloader.download({
    id: '10', title: 'A/B', pages: [{ index: 0, url: 'https://i.pximg.net/10_p0.png' }]
  });
  assert.equal(attempts, 2);
  assert.equal(zipCalls, 0);
  assert.equal(files[0][0], '[pixiv_10] A_B.png');
  assert.deepEqual(result, { kind: 'single', successCount: 1, failureCount: 0 });
});

test('exactly 20% failures creates a partial ZIP and failure list', async () => {
  const attempts = new Map();
  const zip = new FakeZip();
  const downloads = [];
  const downloader = core.createArtworkDownloader({
    requestBinary: async (url) => {
      attempts.set(url, (attempts.get(url) ?? 0) + 1);
      if (url.includes('_p2.')) throw new Error('forbidden');
      return new ArrayBuffer(1);
    },
    createZip: () => zip,
    makeBlob: () => { throw new Error('single Blob path must not run'); },
    downloadFile: async (name, blob) => downloads.push([name, blob])
  });
  const result = await downloader.download({ id: '10', title: '漫画', pages: artworkPages(5) });
  assert.deepEqual(zip.files.map(([name]) => name), [
    '001.jpg', '002.jpg', '004.jpg', '005.jpg', '下载失败.txt'
  ]);
  assert.match(zip.files.at(-1)[1], /第 3 页.*forbidden/);
  assert.deepEqual(zip.generateCalls, [{ type: 'blob', compression: 'STORE' }]);
  assert.equal(downloads[0][0], '[pixiv_10] 漫画.zip');
  assert.deepEqual(result, { kind: 'zip', successCount: 4, failureCount: 1 });
});

test('exceeding 20% failures stops and creates no ZIP download', async () => {
  let attempts = 0;
  const zip = new FakeZip();
  const downloads = [];
  const downloader = core.createArtworkDownloader({
    requestBinary: async () => { attempts += 1; throw new Error('blocked'); },
    createZip: () => zip,
    makeBlob: () => ({}),
    downloadFile: async (...args) => downloads.push(args)
  });
  await assert.rejects(
    downloader.download({ id: '10', title: '漫画', pages: artworkPages(5) }),
    /失败图片超过 20%/
  );
  assert.equal(attempts, 4);
  assert.equal(zip.generateCalls.length, 0);
  assert.equal(downloads.length, 0);
});

test('single image failure retries once and creates no file', async () => {
  let attempts = 0;
  let zipCalls = 0;
  const downloads = [];
  const downloader = core.createArtworkDownloader({
    requestBinary: async () => { attempts += 1; throw new Error('blocked'); },
    createZip: () => { zipCalls += 1; return new FakeZip(); },
    makeBlob: () => ({}),
    downloadFile: async (...args) => downloads.push(args)
  });
  await assert.rejects(
    downloader.download({ id: '10', title: '单图', pages: artworkPages(1) }),
    /blocked/
  );
  assert.equal(attempts, 2);
  assert.equal(zipCalls, 0);
  assert.equal(downloads.length, 0);
});
```

- [ ] **Step 5: Run archive tests RED**

Run `node --test --test-name-pattern="single artwork|partial ZIP|exceeds 20%|single image failure" tests/pixiv-novel-extractor.test.cjs`.

Expected: failures because `createArtworkDownloader` is undefined.

- [ ] **Step 6: Implement archive policy**

`createArtworkDownloader({requestBinary,createZip,makeBlob,downloadFile})` uses this retry helper:

```js
const fetchPage = async (page) => {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await requestBinary(page.url); }
    catch (error) { lastError = error; }
  }
  throw lastError;
};
```

Single-page flow builds an `application/octet-stream` Blob and calls `downloadFile` without creating ZIP. Multi-page flow creates one ZIP, processes sequentially, reports `{phase:'download',done,total}`, adds successes using `formatPageFilename`, and records `{page,url,error}` failures. After every permanent failure:

```js
if (failures.length / total > 0.2) {
  throw new Error(`失败图片超过 20%（${failures.length} / ${total}），已停止下载`);
}
```

At completion, add `下载失败.txt` when needed, then:

```js
const blob = await zip.generateAsync(
  { type: 'blob', compression: 'STORE' },
  (metadata) => onProgress({ phase: 'zip', percent: metadata.percent })
);
await downloadFile(`[pixiv_${artwork.id}] ${sanitizeFilename(artwork.title)}.zip`, blob);
```

Return the exact result objects asserted above and export all three new functions.

- [ ] **Step 7: Verify and commit**

Run the Step 2 and Step 5 commands, the existing UTF-8 download test, `npm test`, and syntax check. Commit:

```powershell
git add pixiv-novel-extractor.user.js tests/pixiv-novel-extractor.test.cjs
git commit -m "feat: download artwork originals and ZIPs"
```

### Task 3: Route artwork pages into the shared panel

**Files:**
- Modify: `pixiv-novel-extractor.user.js:305-523`
- Test: `tests/pixiv-novel-extractor.test.cjs:400-620`

**Interfaces:**
- Produces configurable `createPanel(doc,actions,{titleText,definitions,initialCollapsed,onCollapsedChange})`.
- Produces `createArtworkController(deps): {loadArtwork,downloadArtwork}`.
- Makes `bootstrap(environment)` route either novel or artwork pages.

- [ ] **Step 1: Write a failing configurable-panel test**

```js
test('shared panel renders one artwork action', () => {
  const doc = new FakeDocument();
  const panel = core.createPanel(doc, { downloadArtwork: async () => {} }, {
    titleText: 'Pixiv 作品下载',
    definitions: [['downloadArtwork', '下载当前作品', false]]
  });
  const nodes = descendants(panel.host.shadowRoot);
  assert.equal(nodes.find((node) => node.tagName === 'STRONG').textContent, 'Pixiv 作品下载');
  assert.deepEqual(nodes.filter((node) => node.attributes['data-action']).map((node) => node.textContent), ['下载当前作品']);
});
```

- [ ] **Step 2: Run panel test RED**

Run `node --test --test-name-pattern="shared panel renders" tests/pixiv-novel-extractor.test.cjs`.

Expected: hard-coded novel title/actions make it fail.

- [ ] **Step 3: Generalize panel content**

Rename the existing definitions to `novelActionDefinitions`; add `artworkActionDefinitions = [['downloadArtwork','下载当前作品',false]]`. Extend panel options with `titleText = 'Pixiv 小说提取'` and `definitions = novelActionDefinitions`, use these for title/button construction, and use `titleText` in the collapse tooltip. Preserve all defaults and existing panel tests.

- [ ] **Step 4: Write failing controller and route tests**

```js
test('artwork controller reports download and ZIP progress', async () => {
  const statuses = [];
  const busy = [];
  const artwork = { id: '10', title: '作品', pages: [{}, {}] };
  const controller = core.createArtworkController({
    id: '10',
    client: { getArtwork: async () => artwork },
    downloader: { download: async (_artwork, progress) => {
      progress({ phase: 'download', done: 1, total: 2 });
      progress({ phase: 'zip', percent: 50 });
      return { kind: 'zip', successCount: 2, failureCount: 0 };
    } },
    setStatus: (value) => statuses.push(value),
    setBusy: (value) => busy.push(value)
  });
  await controller.downloadArtwork();
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(statuses, [
    '正在读取作品信息',
    '正在下载原图：1 / 2',
    '正在生成 ZIP：50%',
    'ZIP 下载完成：成功 2 张，失败 0 张'
  ]);
});

test('artwork URL registers only artwork download UI', () => {
  const labels = [];
  let panelOptions;
  const panel = {
    setActions(actions) { this.actions = actions; },
    setStatus() {},
    setBusy() {},
    setSeriesAvailable() {}
  };
  const controller = core.bootstrap({
    href: 'https://www.pixiv.net/artworks/10',
    document: {},
    fetch: async (url) => ({
      ok: true,
      json: async () => url.includes('/pages')
        ? { error: false, body: [{ urls: { original: 'https://i.pximg.net/10_p0.jpg' } }] }
        : { error: false, body: { id: '10', title: '作品', illustType: 0 } }
    }),
    clipboard: () => {},
    download: () => {},
    gmRequest: () => {},
    createZip: () => new FakeZip(),
    registerMenuCommand: (label) => labels.push(label),
    Blob: class {},
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
    delay: async () => {},
    getValue: () => true,
    setValue: () => {},
    createPanel: (_doc, _actions, options) => { panelOptions = options; return panel; }
  });
  assert.deepEqual(labels, ['下载当前作品']);
  assert.equal(panelOptions.titleText, 'Pixiv 作品下载');
  assert.deepEqual(panelOptions.definitions.map((item) => item[1]), ['下载当前作品']);
  assert.equal(panelOptions.initialCollapsed, true);
  assert.equal(typeof controller.downloadArtwork, 'function');
  assert.equal(controller.copyCurrent, undefined);
});
```

- [ ] **Step 5: Run controller/route tests RED**

Run `node --test --test-name-pattern="artwork controller|artwork URL registers" tests/pixiv-novel-extractor.test.cjs`.

Expected: failures because the controller and artwork routing do not exist.

- [ ] **Step 6: Implement controller**

`createArtworkController({id,client,downloader,setStatus,setBusy})` caches `loadArtwork`, uses the novel controller's run/finally pattern, and maps progress to the exact messages in Step 4. Final result is `原图下载完成` for single or `ZIP 下载完成：成功 N 张，失败 N 张` for ZIP. Errors set `失败：原因`, rethrow, and restore busy.

- [ ] **Step 7: Implement route bootstrap**

Extract current setup into `bootstrapNovel(runtime,id,requestJson)`. Add `bootstrapArtwork(runtime,id,requestJson)`, creating the client, downloader, controller, artwork panel, and one menu command. Extend `browserEnvironment` with guarded `gmRequest` and:

```js
createZip: () => {
  if (typeof JSZip !== 'function') throw new Error('ZIP 组件未加载');
  return new JSZip();
}
```

At `bootstrap`, parse both routes, return null for neither, build one `requestJson`, and dispatch to the matching setup. If artwork `gmRequest` is absent, expose `原图请求组件不可用` through normal controller error handling. Preserve novel preload and its three menu commands.

- [ ] **Step 8: Verify and commit**

Run Steps 2 and 5 commands, all existing panel/bootstrap tests, `npm test`, and syntax check. Commit:

```powershell
git add pixiv-novel-extractor.user.js tests/pixiv-novel-extractor.test.cjs
git commit -m "feat: add artwork download panel"
```

### Task 4: Release metadata and documentation

**Files:**
- Modify: `pixiv-novel-extractor.user.js:1-16`
- Modify: `README.md:1-45`
- Test: `tests/pixiv-novel-extractor.test.cjs`

**Interfaces:**
- Produces the installable version `0.3.0` and complete user documentation.

- [ ] **Step 1: Write a failing metadata contract test**

```js
test('metadata declares artwork release dependencies', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pixiv-novel-extractor.user.js'), 'utf8');
  assert.match(source, /\/\/ @version\s+0\.3\.0/);
  assert.match(source, /\/\/ @match\s+https:\/\/www\.pixiv\.net\/artworks\/\*/);
  assert.match(source, /jszip@3\.10\.1\/dist\/jszip\.min\.js/);
  assert.match(source, /\/\/ @grant\s+GM_xmlhttpRequest/);
  assert.match(source, /\/\/ @connect\s+i\.pximg\.net/);
  assert.doesNotMatch(source, /jszip@(?:latest|\*)/i);
});
```

- [ ] **Step 2: Run metadata test RED**

Run `node --test --test-name-pattern="metadata declares artwork" tests/pixiv-novel-extractor.test.cjs`.

Expected: version assertion fails while it remains `0.2.0`.

- [ ] **Step 3: Update release metadata**

```js
// @name         Pixiv 小说与作品下载器
// @version      0.3.0
// @description  提取 Pixiv 小说，并下载插画或漫画作品的原图。
```

Retain both page matches, pinned JSZip, all existing grants, the binary-request grant, and image-host connection.

- [ ] **Step 4: Update README**

Document the one-file install, pinned JSZip load, unchanged novel actions, `下载当前作品`, single direct download, ordered multi-page ZIP, one retry, exact 20% rule, `下载失败.txt`, unsupported ugoira, large-work memory use, local processing, and unchanged access controls.

- [ ] **Step 5: Verify release**

Run:

```powershell
node --test --test-name-pattern="metadata declares artwork" tests/pixiv-novel-extractor.test.cjs
npm test
node --check pixiv-novel-extractor.user.js
rg -n "0\.3\.0|artworks/\*|jszip@3\.10\.1|GM_xmlhttpRequest|i\.pximg\.net|单图|多图|20%|下载失败\.txt|内存|动图" pixiv-novel-extractor.user.js README.md
git diff --check
```

Expected: tests pass, syntax/diff checks exit 0, and every required release term appears.

- [ ] **Step 6: Commit release documentation**

```powershell
git add pixiv-novel-extractor.user.js README.md tests/pixiv-novel-extractor.test.cjs
git commit -m "docs: release artwork downloader 0.3.0"
```

- [ ] **Step 7: Tampermonkey smoke test**

In a signed-in browser, verify one JPG/PNG single work, one multi-page work, simulated exactly-20% and over-20% failures, progress/duplicate-click behavior, and all three novel actions plus cross-page minimize persistence. Record any Pixiv compatibility problem before merging.
