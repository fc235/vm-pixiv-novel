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

  const api = {
    parseNovelId,
    convertPixivText,
    sanitizeFilename,
    formatNovel,
    formatSeries
  };

  function bootstrap() {}

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    bootstrap();
  }
})();
