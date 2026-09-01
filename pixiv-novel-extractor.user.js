// ==UserScript==
// @name         Pixiv 小说提取器
// @namespace    https://github.com/local/pixiv-novel-extractor
// @version      0.2.0
// @description  提取 Pixiv 单篇小说或整个系列，并复制或下载为纯文本，支持可记忆的最小化面板。
// @match        https://www.pixiv.net/novel/show.php?id=*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

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
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\[跳转至第 \d+ 页])\n\n(?=\[插图：)/g, '$1\n')
    .trim();

  const sanitizeFilename = (name) => {
    let cleaned = String(name ?? '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim()
      .replace(/[. ]+$/g, '_');
    cleaned = (cleaned || 'pixiv-novel').slice(0, 120).replace(/[. ]+$/g, '_');
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(cleaned)) {
      cleaned = `_${cleaned}`;
    }
    return cleaned;
  };

  const formatNovel = ({ title, text }) => `${title}\n\n${text}`;

  const formatSeries = (title, results) => [
    title,
    ...results.map((item, index) => {
      const itemTitle = item.ok ? item.novel.title : `作品 ${item.id}`;
      const body = item.ok ? item.novel.text : `[提取失败：${item.error}]`;
      return `===== 第 ${index + 1} 篇：${itemTitle} =====\n\n${body}`;
    })
  ].join('\n\n');

  const requireNumericId = (id, label) => {
    const value = String(id ?? '');
    if (!/^\d+$/.test(value)) throw new Error(`${label}无效`);
    return value;
  };

  const responseBody = (response) => {
    if (!response || response.error) {
      throw new Error(response?.message || 'Pixiv 返回了错误');
    }
    if (!response.body) throw new Error('Pixiv 响应缺少正文数据');
    return response.body;
  };

  const errorMessage = (error) => error instanceof Error ? error.message : String(error);

  const createPixivClient = (requestJson, delay) => {
    const getNovel = async (id) => {
      const novelId = requireNumericId(id, '小说 ID');
      const body = responseBody(await requestJson(`/ajax/novel/${novelId}?lang=zh`));
      if (typeof body.content !== 'string') throw new Error('Pixiv 响应缺少小说正文');

      const seriesId = body.seriesNavData?.seriesId;
      return {
        id: String(body.id ?? novelId),
        title: String(body.title ?? '').trim() || `作品 ${novelId}`,
        text: convertPixivText(body.content),
        series: seriesId == null
          ? null
          : {
              id: requireNumericId(seriesId, '系列 ID'),
              title: String(body.seriesNavData.title ?? '').trim() || `系列 ${seriesId}`
            }
      };
    };

    const getSeriesInfo = async (seriesId) => {
      const id = requireNumericId(seriesId, '系列 ID');
      return responseBody(await requestJson(`/ajax/novel/series/${id}?lang=zh`));
    };

    const getSeriesEntries = async (seriesId) => {
      const id = requireNumericId(seriesId, '系列 ID');
      const entriesById = new Map();
      let lastOrder = 0;
      let total = Number.POSITIVE_INFINITY;

      while (entriesById.size < total) {
        const body = responseBody(await requestJson(
          `/ajax/novel/series_content/${id}?limit=30&last_order=${lastOrder}&order_by=asc&lang=zh`
        ));
        const legacyEntries = body.seriesContents;
        const currentEntries = body.page?.seriesContents;
        if (!Array.isArray(legacyEntries) && !Array.isArray(currentEntries)) {
          throw new Error('Pixiv 响应缺少系列章节列表');
        }
        const pageEntries = Array.isArray(legacyEntries) ? legacyEntries : currentEntries;
        const hasTotal = Number.isFinite(Number(body.total));
        if (hasTotal) total = Number(body.total);
        if (pageEntries.length === 0) {
          if (entriesById.size === 0) throw new Error('系列没有可提取的章节');
          break;
        }

        for (const entry of pageEntries) {
          if (/^\d+$/.test(String(entry?.id ?? ''))) entriesById.set(String(entry.id), entry);
        }

        if ((hasTotal && entriesById.size >= total) || (!hasTotal && pageEntries.length < 30)) break;
        const pageLastOrder = Math.max(...pageEntries.map((entry) => Number(
          entry?.series?.order ?? entry?.series?.contentOrder ?? entry?.seriesContentOrder
        )));
        if (!Number.isFinite(pageLastOrder) || pageLastOrder <= lastOrder) {
          throw new Error('系列分页没有继续前进');
        }
        lastOrder = pageLastOrder;
      }

      return [...entriesById.values()].sort(
        (left, right) => Number(
          left?.series?.order ?? left?.series?.contentOrder ?? left?.seriesContentOrder
        ) - Number(
          right?.series?.order ?? right?.series?.contentOrder ?? right?.seriesContentOrder
        )
      );
    };

    const getWholeSeries = async (seedNovel, onProgress = () => {}) => {
      if (!seedNovel?.series) throw new Error('当前作品不属于系列');
      const entries = await getSeriesEntries(seedNovel.series.id);
      const results = [];

      for (let index = 0; index < entries.length; index += 1) {
        const id = String(entries[index].id);
        try {
          results.push({ ok: true, novel: await getNovel(id) });
        } catch (error) {
          results.push({ ok: false, id, error: errorMessage(error) });
        }
        onProgress(index + 1, entries.length);
        if (index < entries.length - 1) await delay(350);
      }

      const successCount = results.filter((item) => item.ok).length;
      return {
        title: seedNovel.series.title,
        results,
        successCount,
        failureCount: results.length - successCount
      };
    };

    return { getNovel, getSeriesInfo, getSeriesEntries, getWholeSeries };
  };

  const firstMatchingNode = (doc, selectors) => selectors
    .map((selector) => doc.querySelector(selector))
    .find(Boolean);

  const extractNovelFromDocument = (doc, id) => {
    const novelId = requireNumericId(id, '小说 ID');
    const titleNode = firstMatchingNode(doc, ['main h1', 'h1']);
    const textNode = firstMatchingNode(doc, [
      'main > main',
      '[data-testid="novel-text"]',
      'main article',
      'main [role="article"]'
    ]);
    const rawText = textNode?.innerText ?? textNode?.textContent ?? '';
    if (!String(rawText).trim()) throw new Error('未找到页面正文');
    const title = String(titleNode?.textContent ?? '').trim();
    if (!title) throw new Error('未找到页面标题');

    return {
      id: novelId,
      title,
      text: convertPixivText(rawText),
      series: null
    };
  };

  const copyText = async (text, clipboard) => {
    await Promise.resolve(clipboard(text, 'text'));
  };

  const downloadText = (title, text, environment) => {
    const blob = new environment.Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = environment.createObjectURL(blob);

    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        environment.revokeObjectURL(url);
        if (error) reject(error);
        else resolve();
      };

      try {
        environment.download({
          url,
          name: `${sanitizeFilename(title)}.txt`,
          saveAs: true,
          onload: () => finish(),
          onerror: () => finish(new Error('下载失败'))
        });
      } catch (error) {
        finish(error);
      }
    });
  };

  const createController = (dependencies) => {
    const {
      id,
      client,
      doc,
      fallback,
      copy,
      download,
      setStatus,
      setBusy,
      onNovelLoaded
    } = dependencies;
    let currentNovel = null;

    const loadCurrent = async () => {
      if (currentNovel) return currentNovel;
      try {
        currentNovel = await client.getNovel(id);
      } catch (_error) {
        currentNovel = fallback(doc, id);
      }
      onNovelLoaded(currentNovel);
      return currentNovel;
    };

    const run = async (action) => {
      setBusy(true);
      try {
        return await action();
      } catch (error) {
        setStatus(`失败：${errorMessage(error)}`);
        throw error;
      } finally {
        setBusy(false);
      }
    };

    const copyCurrent = () => run(async () => {
      const novel = await loadCurrent();
      await copy(formatNovel(novel));
      setStatus('已复制当前小说');
    });

    const downloadCurrent = () => run(async () => {
      const novel = await loadCurrent();
      await download(novel.title, formatNovel(novel));
      setStatus('已开始下载当前小说');
    });

    const loadSeries = async () => {
      const novel = await loadCurrent();
      if (!novel.series) throw new Error('当前作品不属于系列');
      return client.getWholeSeries(novel, (done, total) => {
        setStatus(`正在提取系列：${done} / ${total}`);
      });
    };

    const seriesDoneStatus = (series) => (
      `系列提取完成：成功 ${series.successCount} 篇，失败 ${series.failureCount} 篇`
    );

    const downloadSeries = () => run(async () => {
      const series = await loadSeries();
      await download(series.title, formatSeries(series.title, series.results));
      setStatus(seriesDoneStatus(series));
    });

    return { loadCurrent, copyCurrent, downloadCurrent, downloadSeries };
  };

  const actionDefinitions = [
    ['copyCurrent', '复制当前小说', false],
    ['downloadCurrent', '下载当前小说', false],
    ['downloadSeries', '下载整个系列', true]
  ];

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

  const createPanel = (doc, initialActions = {}, options = {}) => {
    const {
      initialCollapsed = false,
      onCollapsedChange = () => {}
    } = options;
    const host = doc.createElement('div');
    host.setAttribute('id', 'pixiv-novel-extractor-host');
    const shadow = host.attachShadow({ mode: 'open' });

    const style = doc.createElement('style');
    style.textContent = `
      :host { position: fixed; right: 20px; bottom: 24px; z-index: 2147483647;
        color: #f5f5f5; font: 14px/1.4 system-ui, sans-serif; }
      section { width: 210px; padding: 12px; border: 1px solid #444; border-radius: 12px;
        background: rgba(28, 28, 32, .96); box-shadow: 0 8px 28px rgba(0, 0, 0, .35); }
      section.collapsed { box-sizing: border-box; width: 44px; height: 44px; padding: 0;
        border-radius: 50%; overflow: hidden; }
      section.collapsed header { width: 100%; height: 100%; margin: 0; }
      section.collapsed strong, section.collapsed .actions, section.collapsed .status { display: none; }
      section.collapsed .collapse { width: 100%; height: 100%; padding: 0; border-radius: 50%;
        font-size: 20px; line-height: 1; }
      header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
      strong { font-size: 14px; }
      .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      button { border: 0; border-radius: 8px; padding: 8px; color: #fff; background: #4b4b55;
        cursor: pointer; font: inherit; }
      button:hover:not(:disabled) { background: #62626e; }
      button:disabled { cursor: not-allowed; opacity: .45; }
      .collapse { width: 28px; padding: 3px; background: transparent; }
      .status { min-height: 20px; margin: 9px 0 0; color: #c9c9d2; font-size: 12px; }
    `;

    const section = doc.createElement('section');
    const header = doc.createElement('header');
    const title = doc.createElement('strong');
    title.textContent = 'Pixiv 小说提取';
    const collapse = doc.createElement('button');
    collapse.textContent = '−';
    collapse.setAttribute('class', 'collapse');
    collapse.setAttribute('type', 'button');
    collapse.setAttribute('aria-label', '收起提取面板');
    collapse.setAttribute('data-role', 'panel-toggle');
    header.append(title, collapse);

    const actionBox = doc.createElement('div');
    actionBox.setAttribute('class', 'actions');
    const buttons = [];
    let actions = initialActions;
    let busy = false;
    let seriesAvailable = true;

    for (const [name, label, isSeries] of actionDefinitions) {
      const button = doc.createElement('button');
      button.textContent = label;
      button.setAttribute('type', 'button');
      button.setAttribute('data-action', name);
      button.addEventListener('click', () => {
        const action = actions[name];
        if (typeof action === 'function') Promise.resolve(action()).catch(() => {});
      });
      button.isSeriesAction = isSeries;
      buttons.push(button);
      actionBox.append(button);
    }

    const status = doc.createElement('p');
    status.textContent = '准备就绪';
    status.setAttribute('class', 'status');
    status.setAttribute('aria-live', 'polite');
    section.append(header, actionBox, status);
    shadow.append(style, section);
    doc.body.append(host);

    const refreshButtons = () => {
      for (const button of buttons) {
        button.disabled = busy || (button.isSeriesAction && !seriesAvailable);
      }
    };

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

    return {
      host,
      setActions(nextActions) { actions = nextActions; },
      setStatus(message) { status.textContent = message; },
      setBusy(value) { busy = Boolean(value); refreshButtons(); },
      setSeriesAvailable(value) { seriesAvailable = Boolean(value); refreshButtons(); }
    };
  };

  const browserEnvironment = () => ({
    href: location.href,
    document,
    fetch,
    clipboard: GM_setClipboard,
    download: GM_download,
    getValue: GM_getValue,
    setValue: GM_setValue,
    registerMenuCommand: GM_registerMenuCommand,
    Blob,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    createPanel
  });

  const bootstrap = (environment) => {
    const runtime = environment ?? browserEnvironment();
    const id = parseNovelId(runtime.href);
    if (!id) return null;

    const requestJson = async (url) => {
      const response = await runtime.fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`Pixiv 请求失败（HTTP ${response.status}）`);
      return response.json();
    };
    const client = createPixivClient(requestJson, runtime.delay);
    const panel = runtime.createPanel(runtime.document, {}, {
      initialCollapsed: readCollapsedPreference(runtime.getValue),
      onCollapsedChange: (value) => saveCollapsedPreference(runtime.setValue, value)
    });
    const controller = createController({
      id,
      client,
      doc: runtime.document,
      fallback: extractNovelFromDocument,
      copy: (text) => copyText(text, runtime.clipboard),
      download: (title, text) => downloadText(title, text, {
        Blob: runtime.Blob,
        createObjectURL: runtime.createObjectURL,
        revokeObjectURL: runtime.revokeObjectURL,
        download: runtime.download
      }),
      setStatus: panel.setStatus,
      setBusy: panel.setBusy,
      onNovelLoaded: (novel) => panel.setSeriesAvailable(Boolean(novel.series))
    });
    panel.setActions(controller);

    for (const [name, label] of actionDefinitions) {
      runtime.registerMenuCommand(label, () => {
        Promise.resolve(controller[name]()).catch(() => {});
      });
    }

    controller.loadCurrent().catch((error) => {
      panel.setStatus(`失败：${errorMessage(error)}`);
    });
    return controller;
  };

  const api = {
    parseNovelId,
    convertPixivText,
    sanitizeFilename,
    formatNovel,
    formatSeries,
    createPixivClient,
    extractNovelFromDocument,
    copyText,
    downloadText,
    createController,
    readCollapsedPreference,
    saveCollapsedPreference,
    createPanel,
    bootstrap
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    bootstrap();
  }
})();
