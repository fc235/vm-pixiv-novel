const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../pixiv-novel-extractor.user.js');

test('parses only Pixiv novel detail IDs', () => {
  assert.equal(core.parseNovelId('https://www.pixiv.net/novel/show.php?id=12345'), '12345');
  assert.equal(core.parseNovelId('https://www.pixiv.net/artworks/12345'), null);
});

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

test('converts Pixiv markers to readable text', () => {
  const raw = '[chapter:序章]\n[[rb:漢字 > かんじ]][newpage][jump:3][pixivimage:42]';
  assert.equal(
    core.convertPixivText(raw),
    '序章\n\n漢字（かんじ）\n\n[跳转至第 3 页]\n[插图：Pixiv 作品 42]'
  );
});

test('preserves paragraphs while normalizing line endings and excess blanks', () => {
  assert.equal(core.convertPixivText('甲\r\n\r\n\r\n乙  \r\n'), '甲\n\n乙');
});

test('sanitizes Windows filenames', () => {
  assert.equal(core.sanitizeFilename('A/B:*?"<>|. '), 'A_B________');
  assert.equal(core.sanitizeFilename('   '), 'pixiv-novel');
  assert.ok(core.sanitizeFilename('文'.repeat(200)).length <= 120);
  assert.equal(core.sanitizeFilename('CON'), '_CON');
  assert.equal(core.sanitizeFilename(`${'a'.repeat(119)}.tail`).at(-1), '_');
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

test('maps a Pixiv novel response', async () => {
  const client = core.createPixivClient(async () => ({
    error: false,
    body: {
      id: '10',
      title: '原题',
      content: '[[rb:字 > じ]]',
      seriesNavData: { seriesId: '7', title: '系列名' }
    }
  }), async () => {});

  assert.deepEqual(await client.getNovel('10'), {
    id: '10',
    title: '原题',
    text: '字（じ）',
    series: { id: '7', title: '系列名' }
  });
});

test('paginates series content by last order without duplicates', async () => {
  const urls = [];
  const client = core.createPixivClient(async (url) => {
    urls.push(url);
    return urls.length === 1
      ? {
          error: false,
          body: {
            seriesContents: [
              { id: '10', series: { order: 1 } },
              { id: '11', series: { order: 2 } }
            ],
            total: 3
          }
        }
      : {
          error: false,
          body: {
            seriesContents: [{ id: '12', series: { order: 3 } }],
            total: 3
          }
        };
  }, async () => {});

  assert.deepEqual((await client.getSeriesEntries('7')).map((entry) => entry.id), [
    '10',
    '11',
    '12'
  ]);
  assert.match(urls[1], /last_order=2/);
});

test('supports the current Pixiv page.seriesContents response shape', async () => {
  const client = core.createPixivClient(async () => ({
    error: false,
    body: {
      page: {
        seriesContents: [
          { id: '10', series: { contentOrder: 1 } },
          { id: '11', series: { contentOrder: 2 } }
        ]
      }
    }
  }), async () => {});

  assert.deepEqual((await client.getSeriesEntries('7')).map((entry) => entry.id), ['10', '11']);
});

test('rejects an unrecognized or empty series response', async () => {
  const malformed = core.createPixivClient(async () => ({
    error: false,
    body: { changedSchema: [] }
  }), async () => {});
  const empty = core.createPixivClient(async () => ({
    error: false,
    body: { page: { seriesContents: [] } }
  }), async () => {});

  await assert.rejects(malformed.getSeriesEntries('7'), /系列章节/);
  await assert.rejects(empty.getSeriesEntries('7'), /系列没有可提取的章节/);
});

test('continues a series after one novel fails and reports progress', async () => {
  const progress = [];
  const client = core.createPixivClient(async (url) => {
    if (url.includes('series_content')) {
      return {
        error: false,
        body: {
          seriesContents: [
            { id: '1', series: { order: 1 } },
            { id: '2', series: { order: 2 } }
          ],
          total: 2
        }
      };
    }
    if (url.includes('/2?')) return { error: true, message: '无权访问' };
    return {
      error: false,
      body: {
        id: '1',
        title: '一',
        content: '正文',
        seriesNavData: { seriesId: '7', title: '系列' }
      }
    };
  }, async () => {});

  const result = await client.getWholeSeries(
    { series: { id: '7', title: '系列' } },
    (done, total) => progress.push([done, total])
  );

  assert.equal(result.successCount, 1);
  assert.equal(result.failureCount, 1);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
});

test('extracts title and rendered paragraphs from DOM fallback', () => {
  const nodes = {
    'main h1': { textContent: '标题' },
    '[data-testid="novel-text"]': { innerText: '第一段\n\n第二段' }
  };
  const doc = { querySelector: (selector) => nodes[selector] ?? null };

  assert.deepEqual(core.extractNovelFromDocument(doc, '9'), {
    id: '9',
    title: '标题',
    text: '第一段\n\n第二段',
    series: null
  });
});

test('extracts the current Pixiv nested-main body layout', () => {
  const nodes = {
    'main h1': { textContent: '当前标题' },
    'main > main': { innerText: '当前正文' }
  };
  const doc = { querySelector: (selector) => nodes[selector] ?? null };

  assert.equal(core.extractNovelFromDocument(doc, '9').text, '当前正文');
});

test('rejects an incomplete DOM fallback', () => {
  assert.throws(
    () => core.extractNovelFromDocument({ querySelector: () => null }, '9'),
    /页面正文/
  );
});

test('copyText completes when the clipboard API does not invoke a callback', async () => {
  const calls = [];
  const copying = core.copyText('内容', (text, info) => {
    calls.push([text, info]);
  });
  const outcome = await Promise.race([
    copying.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 20))
  ]);

  assert.equal(outcome, 'resolved');
  assert.deepEqual(calls, [['内容', 'text']]);
});

test('downloads a UTF-8 text blob and revokes its URL', async () => {
  const calls = { blobs: [], downloads: [], revoked: [] };
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options.type;
      calls.blobs.push(this);
    }
  }
  const environment = {
    Blob: FakeBlob,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: (url) => calls.revoked.push(url),
    download: (options) => {
      calls.downloads.push(options);
      options.onload();
    }
  };

  await core.downloadText('A/B', '正文', environment);

  assert.equal(calls.blobs[0].type, 'text/plain;charset=utf-8');
  assert.equal(calls.downloads[0].url, 'blob:test');
  assert.equal(calls.downloads[0].name, 'A_B.txt');
  assert.deepEqual(calls.revoked, ['blob:test']);
});

const makeControllerDependencies = (overrides = {}) => ({
  id: '9',
  client: {
    getNovel: async () => ({ id: '9', title: '标题', text: '正文', series: null }),
    getWholeSeries: async () => ({ title: '系列', results: [], successCount: 0, failureCount: 0 })
  },
  doc: {},
  fallback: () => ({ id: '9', title: '兜底', text: '页面正文', series: null }),
  copy: async () => {},
  download: async () => {},
  setStatus: () => {},
  setBusy: () => {},
  onNovelLoaded: () => {},
  ...overrides
});

test('controller falls back to the rendered document after an API failure', async () => {
  const calls = [];
  const controller = core.createController(makeControllerDependencies({
    client: {
      getNovel: async () => {
        calls.push('api');
        throw new Error('接口失败');
      }
    },
    fallback: () => {
      calls.push('dom');
      return { id: '9', title: '兜底', text: '页面正文', series: null };
    }
  }));

  assert.equal((await controller.loadCurrent()).title, '兜底');
  assert.deepEqual(calls, ['api', 'dom']);
});

test('controller copies and downloads the current novel', async () => {
  const copied = [];
  const downloaded = [];
  const statuses = [];
  const controller = core.createController(makeControllerDependencies({
    copy: async (text) => copied.push(text),
    download: async (title, text) => downloaded.push([title, text]),
    setStatus: (status) => statuses.push(status)
  }));

  await controller.copyCurrent();
  await controller.downloadCurrent();

  assert.deepEqual(copied, ['标题\n\n正文']);
  assert.deepEqual(downloaded, [['标题', '标题\n\n正文']]);
  assert.deepEqual(statuses, ['已复制当前小说', '已开始下载当前小说']);
});

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
      id: '9',
      title: '标题',
      text: '正文',
      series: { id: '7', title: '系列' }
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

test('controller downloads a formatted series using its title', async () => {
  const downloaded = [];
  const client = {
    getNovel: async () => ({
      id: '9',
      title: '标题',
      text: '正文',
      series: { id: '7', title: '系列' }
    }),
    getWholeSeries: async () => ({
      title: '系列',
      results: [{ ok: true, novel: { title: '第一章', text: '甲' } }],
      successCount: 1,
      failureCount: 0
    })
  };
  const controller = core.createController(makeControllerDependencies({
    client,
    download: async (title, text) => downloaded.push([title, text])
  }));

  await controller.downloadSeries();

  assert.equal(downloaded[0][0], '系列');
  assert.match(downloaded[0][1], /^系列\n\n===== 第 1 篇：第一章 =====/);
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.disabled = false;
    this.textContent = '';
  }

  append(...children) {
    this.children.push(...children);
  }

  attachShadow() {
    this.shadowRoot = new FakeElement('shadow-root');
    return this.shadowRoot;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(name, listener) {
    this.listeners[name] = listener;
  }

  click() {
    this.listeners.click?.();
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

const descendants = (element) => [
  element,
  ...element.children.flatMap((child) => descendants(child))
];

test('floating panel exposes three actions and preserves standalone series disabling', () => {
  const doc = new FakeDocument();
  const actions = {
    copyCurrent: async () => {},
    downloadCurrent: async () => {},
    downloadSeries: async () => {}
  };
  const panel = core.createPanel(doc, actions);
  const nodes = descendants(panel.host.shadowRoot);
  const actionButtons = nodes.filter((node) => node.attributes['data-action']);
  const status = nodes.find((node) => node.attributes['aria-live'] === 'polite');

  assert.deepEqual(actionButtons.map((button) => button.textContent), [
    '复制当前小说',
    '下载当前小说',
    '下载整个系列'
  ]);
  assert.ok(actionButtons.every((button) => typeof button.listeners.click === 'function'));
  assert.ok(status);

  panel.setSeriesAvailable(false);
  panel.setBusy(true);
  panel.setBusy(false);

  assert.equal(actionButtons[0].disabled, false);
  assert.equal(actionButtons[1].disabled, false);
  assert.equal(actionButtons[2].disabled, true);
});

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

test('collapsed-panel CSS defines the compact launcher contract', () => {
  const doc = new FakeDocument();
  const panel = core.createPanel(doc);
  const style = panel.host.shadowRoot.children.find((node) => node.tagName === 'STYLE');
  const collapsedRule = style.textContent.match(/section\.collapsed\s*\{([^}]*)}/)?.[1];
  const hiddenRule = style.textContent.match(
    /section\.collapsed strong, section\.collapsed \.actions, section\.collapsed \.status\s*\{([^}]*)}/
  )?.[1];

  assert.match(collapsedRule, /\bwidth:\s*44px/);
  assert.match(collapsedRule, /\bheight:\s*44px/);
  assert.match(collapsedRule, /\bborder-radius:\s*50%/);
  assert.match(hiddenRule, /\bdisplay:\s*none/);
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

test('userscript bootstrap tolerates unavailable preference globals', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pixiv-novel-extractor.user.js'), 'utf8');
  const sandbox = {
    URL,
    location: { href: 'https://www.pixiv.net/novel/show.php?id=not-a-novel' },
    document: {},
    fetch: () => {},
    GM_setClipboard: () => {},
    GM_download: () => {},
    GM_registerMenuCommand: () => {},
    Blob: class {},
    Promise,
    setTimeout
  };

  assert.doesNotThrow(() => vm.runInNewContext(source, sandbox));
});

test('bootstrap registers the three menu commands on a valid novel URL', () => {
  const labels = [];
  const writes = [];
  let panelOptions;
  const panel = {
    setActions(actions) { this.actions = actions; },
    setStatus() {},
    setBusy() {},
    setSeriesAvailable() {}
  };
  const controller = core.bootstrap({
    href: 'https://www.pixiv.net/novel/show.php?id=9',
    document: {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    clipboard: () => {},
    download: () => {},
    registerMenuCommand: (label) => labels.push(label),
    Blob: class {},
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
    delay: async () => {},
    getValue: (key, defaultValue) => {
      assert.equal(key, 'panelCollapsed');
      assert.equal(defaultValue, false);
      return true;
    },
    setValue: (key, value) => writes.push([key, value]),
    createPanel: (_doc, _actions, options) => {
      panelOptions = options;
      return panel;
    }
  });

  assert.deepEqual(labels, [
    '复制当前小说',
    '下载当前小说',
    '下载整个系列'
  ]);
  assert.equal(typeof controller.copyCurrent, 'function');
  assert.equal(controller.copySeries, undefined);
  assert.equal(panel.actions, controller);
  assert.equal(panelOptions.initialCollapsed, true);
  panelOptions.onCollapsedChange(false);
  assert.deepEqual(writes, [['panelCollapsed', false]]);
});
