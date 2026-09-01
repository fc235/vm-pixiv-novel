// ==UserScript==
// @name         Pixiv 小说提取器
// @namespace    https://github.com/local/pixiv-novel-extractor
// @version      0.1.0
// @description  提取 Pixiv 单篇小说或整个系列，并复制或下载为纯文本。
// @match        https://www.pixiv.net/novel/show.php?id=*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_download
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
    const cleaned = String(name ?? '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim()
      .replace(/[. ]+$/g, '_');
    return (cleaned || 'pixiv-novel').slice(0, 120);
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
        const pageEntries = Array.isArray(body.seriesContents) ? body.seriesContents : [];
        total = Number.isFinite(Number(body.total)) ? Number(body.total) : pageEntries.length;
        if (pageEntries.length === 0) break;

        for (const entry of pageEntries) {
          if (/^\d+$/.test(String(entry?.id ?? ''))) entriesById.set(String(entry.id), entry);
        }

        if (entriesById.size >= total) break;
        const pageLastOrder = Math.max(...pageEntries.map((entry) => Number(entry?.series?.order)));
        if (!Number.isFinite(pageLastOrder) || pageLastOrder <= lastOrder) {
          throw new Error('系列分页没有继续前进');
        }
        lastOrder = pageLastOrder;
      }

      return [...entriesById.values()].sort(
        (left, right) => Number(left?.series?.order) - Number(right?.series?.order)
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
    await Promise.resolve(clipboard(text, 'text/plain'));
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

  const api = {
    parseNovelId,
    convertPixivText,
    sanitizeFilename,
    formatNovel,
    formatSeries,
    createPixivClient,
    extractNovelFromDocument,
    copyText,
    downloadText
  };

  function bootstrap() {}

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    bootstrap();
  }
})();
