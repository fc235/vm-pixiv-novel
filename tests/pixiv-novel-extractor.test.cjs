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
