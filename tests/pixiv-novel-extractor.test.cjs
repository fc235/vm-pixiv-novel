const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../pixiv-novel-extractor.user.js');

test('parses only Pixiv novel detail IDs', () => {
  assert.equal(core.parseNovelId('https://www.pixiv.net/novel/show.php?id=12345'), '12345');
  assert.equal(core.parseNovelId('https://www.pixiv.net/artworks/12345'), null);
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
