# Remove Series Copy and Complete Minimize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the whole-series copy action and turn the floating panel's collapse control into a persistent 44px circular launcher.

**Architecture:** Keep the userscript as one file and retain the existing series extraction/formatting pipeline for series downloads. Remove only the series-copy controller/action wiring, then drive the existing Shadow DOM panel with one `collapsed` CSS state and inject small preference callbacks from `bootstrap` so UI rendering stays separate from Tampermonkey storage.

**Tech Stack:** JavaScript userscript, Tampermonkey `GM_getValue`/`GM_setValue`, Shadow DOM, Node.js built-in test runner.

## Global Constraints

- The complete panel exposes exactly `复制当前小说`, `下载当前小说`, and `下载整个系列`.
- The minimized UI is one fixed, approximately 44px circular button at the lower right, with no visible title, status, actions, or empty panel area.
- The minimized preference persists across refreshes and other Pixiv novel pages.
- Storage failures must not prevent in-page minimize/restore behavior.
- Keep the callback-free `GM_setClipboard(text, 'text')` behavior unchanged.
- Keep series extraction, formatting, throttling, progress, and whole-series download behavior unchanged.
- Store only one boolean UI preference; never store novel or account data.

---

## File Map

- Modify `pixiv-novel-extractor.user.js`: remove the series-copy action, implement compact panel state, bridge Tampermonkey preference storage, and bump metadata to version `0.2.0`.
- Modify `tests/pixiv-novel-extractor.test.cjs`: update action/controller expectations and add compact-state and preference-failure coverage.
- Modify `README.md`: list the three remaining actions and document persistent minimize behavior.

### Task 1: Remove the whole-series copy action

**Files:**
- Modify: `pixiv-novel-extractor.user.js:294-314`
- Test: `tests/pixiv-novel-extractor.test.cjs:285-353`
- Test: `tests/pixiv-novel-extractor.test.cjs:398-460`

**Interfaces:**
- Consumes: existing `loadSeries(): Promise<SeriesResult>` and `downloadSeries(): Promise<void>` controller flow.
- Produces: `createController(...)` without `copySeries`; `actionDefinitions` with exactly three tuples.

- [ ] **Step 1: Update tests to require only three actions**

Replace the standalone-series controller test with a download assertion, change the partial-success test to exercise download, and update panel/bootstrap expectations:

```js
test('controller rejects series download for standalone novels', async () => {
  const statuses = [];
  const controller = core.createController(makeControllerDependencies({
    setStatus: (status) => statuses.push(status)
  }));

  await assert.rejects(controller.downloadSeries(), /当前作品不属于系列/);
  assert.equal(statuses.at(-1), '失败：当前作品不属于系列');
  assert.equal(controller.copySeries, undefined);
});

test('controller reports series progress and partial success while downloading', async () => {
  const statuses = [];
  const downloaded = [];
  const results = [
    { ok: true, novel: { title: '第一章', text: '甲' } },
    { ok: false, id: '2', error: '无权访问' }
  ];
  const client = {
    getNovel: async () => ({
      id: '9', title: '标题', text: '正文', series: { id: '7', title: '系列' }
    }),
    getWholeSeries: async (_novel, onProgress) => {
      onProgress(1, 2);
      onProgress(2, 2);
      return { title: '系列', results, successCount: 1, failureCount: 1 };
    }
  };
  const controller = core.createController(makeControllerDependencies({
    client,
    download: async (title, text) => downloaded.push([title, text]),
    setStatus: (status) => statuses.push(status)
  }));

  await controller.downloadSeries();

  assert.equal(statuses[0], '正在提取系列：1 / 2');
  assert.equal(statuses.at(-1), '系列提取完成：成功 1 篇，失败 1 篇');
  assert.match(downloaded[0][1], /第 2 篇：作品 2/);
});
```

In the panel test, remove `copySeries` from the action fixture and expect:

```js
assert.deepEqual(actionButtons.map((button) => button.textContent), [
  '复制当前小说',
  '下载当前小说',
  '下载整个系列'
]);
assert.equal(actionButtons[0].disabled, false);
assert.equal(actionButtons[1].disabled, false);
assert.equal(actionButtons[2].disabled, true);
```

In the bootstrap test, rename it to `bootstrap registers the three menu commands on a valid novel URL` and expect:

```js
assert.deepEqual(labels, [
  '复制当前小说',
  '下载当前小说',
  '下载整个系列'
]);
assert.equal(controller.copySeries, undefined);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
node --test --test-name-pattern="controller rejects series download|partial success while downloading|floating panel exposes|three menu commands" tests/pixiv-novel-extractor.test.cjs
```

Expected: FAIL because `copySeries` still exists and panel/menu labels still contain `复制整个系列`.

- [ ] **Step 3: Remove only the series-copy wiring**

Delete the `copySeries` function from `createController`, change its return value, and change `actionDefinitions` to:

```js
return { loadCurrent, copyCurrent, downloadCurrent, downloadSeries };
```

```js
const actionDefinitions = [
  ['copyCurrent', '复制当前小说', false],
  ['downloadCurrent', '下载当前小说', false],
  ['downloadSeries', '下载整个系列', true]
];
```

Leave `formatSeries`, `loadSeries`, `seriesDoneStatus`, and `downloadSeries` intact.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run the Step 2 command again.

Expected: all selected tests PASS; no assertion contains `复制整个系列`.

- [ ] **Step 5: Commit the removal**

```powershell
git add pixiv-novel-extractor.user.js tests/pixiv-novel-extractor.test.cjs
git commit -m "feat: remove whole-series copy action"
```

### Task 2: Implement the persistent circular minimized state

**Files:**
- Modify: `pixiv-novel-extractor.user.js:316-414`
- Modify: `pixiv-novel-extractor.user.js:416-479`
- Test: `tests/pixiv-novel-extractor.test.cjs:355-460`

**Interfaces:**
- Consumes: `createPanel(doc, initialActions, options)` where `options.initialCollapsed` is boolean and `options.onCollapsedChange(value)` receives a boolean.
- Produces: `readCollapsedPreference(getValue): boolean`, `saveCollapsedPreference(setValue, value): void`, and a panel whose single toggle owns both full and compact presentation.

- [ ] **Step 1: Extend the fake DOM and add failing compact-state tests**

Add click support to `FakeElement`:

```js
click() {
  this.listeners.click?.();
}
```

Add these tests after the existing panel test:

```js
test('panel minimizes to one circular launcher and restores without rebuilding', () => {
  const doc = new FakeDocument();
  const changes = [];
  const panel = core.createPanel(doc, {}, {
    initialCollapsed: false,
    onCollapsedChange: (value) => changes.push(value)
  });
  const nodes = descendants(panel.host.shadowRoot);
  const section = nodes.find((node) => node.tagName === 'SECTION');
  const toggle = nodes.find((node) => node.attributes['data-role'] === 'panel-toggle');
  const originalChildCount = panel.host.shadowRoot.children.length;

  assert.equal(toggle.attributes['aria-expanded'], 'true');
  toggle.click();
  assert.equal(section.attributes.class, 'collapsed');
  assert.equal(toggle.textContent, '▤');
  assert.equal(toggle.attributes['aria-label'], '展开提取面板');
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.deepEqual(changes, [true]);

  toggle.click();
  assert.equal(section.attributes.class, '');
  assert.equal(toggle.textContent, '−');
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.deepEqual(changes, [true, false]);
  assert.equal(panel.host.shadowRoot.children.length, originalChildCount);
});

test('panel starts minimized without writing the preference again', () => {
  const doc = new FakeDocument();
  const changes = [];
  const panel = core.createPanel(doc, {}, {
    initialCollapsed: true,
    onCollapsedChange: (value) => changes.push(value)
  });
  const nodes = descendants(panel.host.shadowRoot);
  const section = nodes.find((node) => node.tagName === 'SECTION');
  const toggle = nodes.find((node) => node.attributes['data-role'] === 'panel-toggle');

  assert.equal(section.attributes.class, 'collapsed');
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.deepEqual(changes, []);
});

test('collapsed preference reads and writes safely when storage throws', () => {
  assert.equal(core.readCollapsedPreference(() => true), true);
  assert.equal(core.readCollapsedPreference(() => { throw new Error('blocked'); }), false);
  assert.doesNotThrow(() => core.saveCollapsedPreference(() => { throw new Error('blocked'); }, true));
});
```

- [ ] **Step 2: Run compact-state tests and verify they fail**

Run:

```powershell
node --test --test-name-pattern="minimizes to one circular|starts minimized|preference reads" tests/pixiv-novel-extractor.test.cjs
```

Expected: FAIL because `createPanel` ignores options and the preference helpers do not exist.

- [ ] **Step 3: Add safe preference helpers and Tampermonkey grants**

Add metadata grants:

```js
// @grant        GM_getValue
// @grant        GM_setValue
```

Add near `actionDefinitions`:

```js
const PANEL_COLLAPSED_KEY = 'panelCollapsed';

const readCollapsedPreference = (getValue) => {
  try {
    return typeof getValue === 'function'
      ? Boolean(getValue(PANEL_COLLAPSED_KEY, false))
      : false;
  } catch (_error) {
    return false;
  }
};

const saveCollapsedPreference = (setValue, value) => {
  try {
    if (typeof setValue === 'function') {
      Promise.resolve(setValue(PANEL_COLLAPSED_KEY, Boolean(value))).catch(() => {});
    }
  } catch (_error) {
    // Current-page UI state remains usable when storage is unavailable.
  }
};
```

Export both helpers in `api`.

- [ ] **Step 4: Replace the old collapse behavior with one CSS state**

Change the signature and options initialization:

```js
const createPanel = (doc, initialActions = {}, options = {}) => {
  const {
    initialCollapsed = false,
    onCollapsedChange = () => {}
  } = options;
```

Add the following compact-state CSS after the base `section` rule:

```css
section.collapsed { box-sizing: border-box; width: 44px; height: 44px; padding: 0;
  border-radius: 50%; overflow: hidden; }
section.collapsed header { width: 100%; height: 100%; margin: 0; }
section.collapsed strong, section.collapsed .actions, section.collapsed .status { display: none; }
section.collapsed .collapse { width: 100%; height: 100%; padding: 0; border-radius: 50%;
  font-size: 20px; line-height: 1; }
```

Mark the toggle:

```js
collapse.setAttribute('data-role', 'panel-toggle');
```

Replace the old `hidden`-attribute click handler with:

```js
let collapsed = Boolean(initialCollapsed);
const renderCollapsed = () => {
  section.setAttribute('class', collapsed ? 'collapsed' : '');
  collapse.textContent = collapsed ? '▤' : '−';
  collapse.setAttribute('title', collapsed ? '展开 Pixiv 小说提取面板' : '最小化 Pixiv 小说提取面板');
  collapse.setAttribute('aria-label', collapsed ? '展开提取面板' : '最小化提取面板');
  collapse.setAttribute('aria-expanded', String(!collapsed));
};

renderCollapsed();
collapse.addEventListener('click', () => {
  collapsed = !collapsed;
  renderCollapsed();
  onCollapsedChange(collapsed);
});
```

The CSS, not per-node `hidden` mutation, is the source of visual truth.

- [ ] **Step 5: Wire persisted state through bootstrap**

Extend `browserEnvironment`:

```js
getValue: GM_getValue,
setValue: GM_setValue,
```

Create the panel in `bootstrap` with injected preferences:

```js
const panel = runtime.createPanel(runtime.document, {}, {
  initialCollapsed: readCollapsedPreference(runtime.getValue),
  onCollapsedChange: (value) => saveCollapsedPreference(runtime.setValue, value)
});
```

This keeps storage failures outside panel rendering and does not write during initial state restoration.

- [ ] **Step 6: Run focused and full tests**

Run:

```powershell
node --test --test-name-pattern="floating panel|minimizes to one circular|starts minimized|preference reads|three menu commands" tests/pixiv-novel-extractor.test.cjs
npm test
node --check pixiv-novel-extractor.user.js
```

Expected: focused tests PASS, then all tests PASS, and syntax check exits with code 0.

- [ ] **Step 7: Commit compact-state behavior**

```powershell
git add pixiv-novel-extractor.user.js tests/pixiv-novel-extractor.test.cjs
git commit -m "feat: persist compact extractor panel"
```

### Task 3: Update metadata and user documentation

**Files:**
- Modify: `pixiv-novel-extractor.user.js:1-10`
- Modify: `README.md:1-31`

**Interfaces:**
- Consumes: the three-action UI and persistent minimized state implemented by Tasks 1 and 2.
- Produces: installable userscript metadata version `0.2.0` and accurate user-facing documentation.

- [ ] **Step 1: Update userscript metadata**

Set:

```js
// @version      0.2.0
// @description  提取 Pixiv 单篇小说或整个系列，并复制或下载为纯文本，支持可记忆的最小化面板。
```

Keep all existing grants plus the `GM_getValue` and `GM_setValue` grants from Task 2.

- [ ] **Step 2: Update README functionality and interaction copy**

Replace the feature list and add the minimize description:

```markdown
## 功能

- 复制当前小说
- 下载当前小说
- 下载整个系列

面板右上角的最小化按钮可将面板缩成右下角的圆形图标；再次点击图标即可恢复。脚本会记住最小化状态，刷新页面或打开另一篇 Pixiv 小说后仍保持原状态。
```

Keep the series formatting, access limitations, privacy, installation, and verification sections unchanged.

- [ ] **Step 3: Verify documentation and metadata contain no stale feature labels**

Run:

```powershell
rg "复制整个系列|@version|GM_getValue|GM_setValue|最小化" README.md pixiv-novel-extractor.user.js
```

Expected: no `复制整个系列` match; version is `0.2.0`; both storage grants and README minimize text are present.

- [ ] **Step 4: Run final verification**

Run:

```powershell
npm test
node --check pixiv-novel-extractor.user.js
git diff --check
git status --short
```

Expected: all tests PASS, syntax check and diff check exit with code 0, and only the intended documentation/metadata changes are uncommitted.

- [ ] **Step 5: Commit documentation and metadata**

```powershell
git add README.md pixiv-novel-extractor.user.js
git commit -m "docs: update extractor actions and minimize behavior"
```

- [ ] **Step 6: Perform a Tampermonkey smoke test**

Install the updated `pixiv-novel-extractor.user.js`, open a valid Pixiv novel page, and verify:

1. Exactly three actions appear and only `下载整个系列` is disabled for standalone novels.
2. `复制当前小说` finishes without a loading hang and clipboard text begins with the title.
3. Minimize leaves only the circular launcher; refresh and another novel page preserve it.
4. Restore shows the full panel once; current and series downloads still work.

Expected: all four observations match without console errors.
