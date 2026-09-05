// ==UserScript==
// @name         Pixiv 小说与作品下载器
// @namespace    https://github.com/local/pixiv-novel-extractor
// @version      0.3.0
// @description  提取 Pixiv 小说，并下载插画或漫画作品的原图。
// @match        https://www.pixiv.net/novel/show.php?id=*
// @match        https://www.pixiv.net/artworks/*
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      i.pximg.net
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

  const parseArtworkId = (url) => {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^\/artworks\/(\d+)\/?$/);
      return parsed.hostname === 'www.pixiv.net' ? match?.[1] ?? null : null;
    } catch (_error) {
      return null;
    }
  };

  const imageExtension = (url) => {
    try {
      const value = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
      return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(value) ? value : 'jpg';
    } catch (_error) {
      return 'jpg';
    }
  };

  const formatPageFilename = (index, total, url) => (
    `${String(index + 1).padStart(Math.max(3, String(total).length), '0')}.${imageExtension(url)}`
  );

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

  const createArtworkClient = (requestJson) => {
    const getArtwork = async (id) => {
      const artworkId = requireNumericId(id, '作品 ID');
      const info = responseBody(await requestJson(`/ajax/illust/${artworkId}?lang=zh`));
      if (Number(info.illustType) === 2) throw new Error('动图作品暂不支持');

      const pages = responseBody(await requestJson(`/ajax/illust/${artworkId}/pages?lang=zh`));
      if (!Array.isArray(pages) || pages.length === 0) throw new Error('作品没有可下载的页面');
      const mappedPages = pages.map((page, index) => {
        const url = page?.urls?.original;
        if (typeof url !== 'string' || !/^https:\/\/i\.pximg\.net\//.test(url)) {
          throw new Error('作品缺少原图地址');
        }
        return { index, url };
      });

      return {
        id: String(info.id ?? artworkId),
        title: String(info.title ?? '').trim() || `作品 ${artworkId}`,
        pages: mappedPages
      };
    };

    return { getArtwork };
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

  const requestBinary = (url, gmRequest) => new Promise((resolve, reject) => {
    try {
      gmRequest({
        method: 'GET',
        url,
        headers: { Referer: 'https://www.pixiv.net/' },
        responseType: 'arraybuffer',
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) resolve(response.response);
          else reject(new Error(`HTTP ${response.status}`));
        },
        onerror: () => reject(new Error('图片请求失败')),
        ontimeout: () => reject(new Error('图片请求超时'))
      });
    } catch (error) {
      reject(error);
    }
  });

  const downloadBlob = (filename, blob, environment) => {
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
          name: filename,
          saveAs: true,
          onload: () => finish(),
          onerror: () => finish(new Error('下载失败'))
        });
      } catch (error) {
        finish(error);
      }
    });
  };

  const downloadText = (title, text, environment) => {
    const blob = new environment.Blob([text], { type: 'text/plain;charset=utf-8' });
    return downloadBlob(`${sanitizeFilename(title)}.txt`, blob, environment);
  };

  const createArtworkDownloader = ({ requestBinary: fetchBinary, createZip, makeBlob, downloadFile }) => {
    const fetchPage = async (page) => {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await fetchBinary(page.url);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    };

    const download = async (artwork, onProgress = () => {}) => {
      const total = artwork.pages.length;
      onProgress({ phase: 'download', done: 0, total });
      if (total === 1) {
        const page = artwork.pages[0];
        const data = await fetchPage(page);
        const blob = makeBlob([data], { type: 'application/octet-stream' });
        await downloadFile(
          `[pixiv_${artwork.id}] ${sanitizeFilename(artwork.title)}.${imageExtension(page.url)}`,
          blob
        );
        return { kind: 'single', successCount: 1, failureCount: 0 };
      }

      const zip = createZip();
      const failures = [];
      let successCount = 0;
      for (let index = 0; index < total; index += 1) {
        const page = artwork.pages[index];
        try {
          zip.file(formatPageFilename(page.index, total, page.url), await fetchPage(page));
          successCount += 1;
        } catch (error) {
          failures.push({ page, url: page.url, error });
          if (failures.length / total > 0.2) {
            throw new Error(`失败图片超过 20%（${failures.length} / ${total}），已停止下载`);
          }
        }
        onProgress({ phase: 'download', done: index + 1, total });
      }

      if (failures.length) {
        zip.file('下载失败.txt', failures.map(({ page, url, error }) => (
          `第 ${page.index + 1} 页：${url} — ${errorMessage(error)}`
        )).join('\n'));
      }
      const blob = await zip.generateAsync(
        { type: 'blob', compression: 'STORE' },
        (metadata) => onProgress({ phase: 'zip', percent: metadata.percent })
      );
      await downloadFile(`[pixiv_${artwork.id}] ${sanitizeFilename(artwork.title)}.zip`, blob);
      return { kind: 'zip', successCount, failureCount: failures.length };
    };

    return { download };
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

  const createArtworkController = ({ resolveId, client, downloader, setStatus, setBusy }) => {
    const artworkById = new Map();
    let activeDownload = null;

    const currentArtworkId = () => {
      const id = resolveId();
      if (!id) throw new Error('当前页面不是有效的作品页面');
      return id;
    };

    const loadArtwork = async (id = currentArtworkId()) => {
      if (artworkById.has(id)) return artworkById.get(id);
      setStatus('正在读取作品信息');
      const artwork = await client.getArtwork(id);
      artworkById.set(id, artwork);
      return artwork;
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

    const downloadArtwork = () => {
      if (activeDownload) return activeDownload;
      activeDownload = run(async () => {
        const id = currentArtworkId();
        const artwork = await loadArtwork(id);
        const result = await downloader.download(artwork, (progress) => {
          if (progress.phase === 'download') {
            setStatus(`正在下载原图：${progress.done} / ${progress.total}`);
          } else if (progress.phase === 'zip') {
            setStatus(`正在生成 ZIP：${Math.round(progress.percent)}%`);
          }
        });
        setStatus(result.kind === 'single'
          ? '原图下载完成'
          : `ZIP 下载完成：成功 ${result.successCount} 张，失败 ${result.failureCount} 张`);
      }).finally(() => {
        activeDownload = null;
      });
      return activeDownload;
    };

    return { loadArtwork, downloadArtwork };
  };

  const novelActionDefinitions = [
    ['copyCurrent', '复制当前小说', false],
    ['downloadCurrent', '下载当前小说', false],
    ['downloadSeries', '下载整个系列', true]
  ];
  const artworkActionDefinitions = [
    ['downloadArtwork', '下载当前作品', false]
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
      titleText = 'Pixiv 小说提取',
      definitions = novelActionDefinitions,
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
    title.textContent = titleText;
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

    for (const [name, label, isSeries] of definitions) {
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
      collapse.setAttribute('title', collapsed ? `展开 ${titleText}面板` : `最小化 ${titleText}面板`);
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
    getHref: () => location.href,
    document,
    fetch,
    clipboard: GM_setClipboard,
    download: GM_download,
    gmRequest: typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : undefined,
    getValue: typeof GM_getValue === 'function' ? GM_getValue : undefined,
    setValue: typeof GM_setValue === 'function' ? GM_setValue : undefined,
    registerMenuCommand: GM_registerMenuCommand,
    Blob,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    createZip: () => {
      if (typeof JSZip !== 'function') throw new Error('ZIP 组件未加载');
      return new JSZip();
    },
    createPanel
  });

  const bootstrapNovel = (runtime, id, requestJson) => {
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

    for (const [name, label] of novelActionDefinitions) {
      runtime.registerMenuCommand(label, () => {
        Promise.resolve(controller[name]()).catch(() => {});
      });
    }

    controller.loadCurrent().catch((error) => {
      panel.setStatus(`失败：${errorMessage(error)}`);
    });
    return controller;
  };

  const bootstrapArtwork = (runtime, getHref, requestJson) => {
    const client = createArtworkClient(requestJson);
    const panel = runtime.createPanel(runtime.document, {}, {
      titleText: 'Pixiv 作品下载',
      definitions: artworkActionDefinitions,
      initialCollapsed: readCollapsedPreference(runtime.getValue),
      onCollapsedChange: (value) => saveCollapsedPreference(runtime.setValue, value)
    });
    const downloader = createArtworkDownloader({
      requestBinary: (url) => {
        if (typeof runtime.gmRequest !== 'function') throw new Error('原图请求组件不可用');
        return requestBinary(url, runtime.gmRequest);
      },
      createZip: runtime.createZip,
      makeBlob: (parts, options) => new runtime.Blob(parts, options),
      downloadFile: (filename, blob) => downloadBlob(filename, blob, {
        createObjectURL: runtime.createObjectURL,
        revokeObjectURL: runtime.revokeObjectURL,
        download: runtime.download
      })
    });
    const controller = createArtworkController({
      resolveId: () => parseArtworkId(getHref()),
      client,
      downloader,
      setStatus: panel.setStatus,
      setBusy: panel.setBusy
    });
    panel.setActions(controller);

    for (const [name, label] of artworkActionDefinitions) {
      runtime.registerMenuCommand(label, () => {
        Promise.resolve(controller[name]()).catch(() => {});
      });
    }

    return controller;
  };

  const bootstrap = (environment) => {
    const runtime = environment ?? browserEnvironment();
    const getHref = typeof runtime.getHref === 'function'
      ? runtime.getHref
      : () => runtime.href;
    const initialHref = getHref();
    const novelId = parseNovelId(initialHref);
    const artworkId = parseArtworkId(initialHref);
    if (!novelId && !artworkId) return null;

    const requestJson = async (url) => {
      const response = await runtime.fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`Pixiv 请求失败（HTTP ${response.status}）`);
      return response.json();
    };

    return novelId
      ? bootstrapNovel(runtime, novelId, requestJson)
      : bootstrapArtwork(runtime, getHref, requestJson);
  };

  const api = {
    parseNovelId,
    parseArtworkId,
    imageExtension,
    formatPageFilename,
    convertPixivText,
    sanitizeFilename,
    formatNovel,
    formatSeries,
    createPixivClient,
    createArtworkClient,
    extractNovelFromDocument,
    copyText,
    requestBinary,
    downloadBlob,
    downloadText,
    createArtworkDownloader,
    createController,
    createArtworkController,
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
