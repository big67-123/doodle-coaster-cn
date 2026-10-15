import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/*
 * 作用域遮蔽检查。
 *
 * 为什么需要它：index.html 是一个大 IIFE，模块级变量（raw / ctrl / track / ride / mode …）
 * 靠闭包被几十个函数共享。只要某个函数里不小心写了一个同名局部变量，这个函数对那个名字的
 * 读取就会静默地指向局部变量 —— 不报错、不抛异常，只是行为悄悄变掉。
 *
 * 真实事故：给 frame() 加慢动作时把原来的 `const dt = ...` 改名成了 `const raw = ...`，
 * 于是 frame 里那个"绘制中的线条预览"分支读到的是一个数字，`raw.length > 1` 恒为假，
 * 画轨道时的实时预览整条失效 —— 而松手后 finishDraw 在 frame 外读的仍是真正的数组，
 * 所以轨道照常生成，只有"画的过程看不见"这一个症状，肉眼看代码根本发现不了。
 *
 * 做法：花括号深度。深度 == 1 就是 IIFE 体那一层，那里的 let/var 才算模块级。
 * 深度 >= 2 处出现同名 const/let/var 就是遮蔽。
 *
 * 局限（已知，够用）：字符串/注释剥离是近似的，也不做真正的词法作用域分析。
 * 它专抓"低缩进函数体里遮蔽模块级变量"这一类，这正是本文件里出现过的那一类。
 */

function inlineScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'index.html 里应该有一个内联 <script>');
  return m[1];
}

// 把字符串 / 模板 / 注释替换成空格（保留换行），只为数括号深度。
function strip(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += ' '; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += ' '; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

function analyse(html) {
  const src = inlineScript(html);
  const clean = strip(src);
  const rawLines = src.split('\n');
  const cleanLines = clean.split('\n');

  const depthAt = [];
  let d = 0;
  for (let i = 0; i < cleanLines.length; i++) {
    depthAt[i] = d;
    for (const ch of cleanLines[i]) { if (ch === '{') d++; else if (ch === '}') d--; }
  }

  // 模块级可变量：深度 == 1 的 let / var
  const moduleLevel = new Set();
  cleanLines.forEach((l, i) => {
    if (depthAt[i] !== 1) return;
    const m = l.match(/^\s*(?:let|var)\s+([^;]*?);\s*$/);
    if (!m) return;
    for (const part of m[1].split(',')) {
      const nm = part.trim().split(/[\s=]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) moduleLevel.add(nm);
    }
  });

  // 遮蔽：深度 >= 2 处重新声明了模块级名字
  const shadows = [];
  cleanLines.forEach((l, i) => {
    const m = l.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (!m) return;
    if (depthAt[i] <= 1) return;
    if (!moduleLevel.has(m[1])) return;
    shadows.push({ line: i + 1, name: m[1], depth: depthAt[i], text: rawLines[i].trim() });
  });

  return { src, moduleLevel, shadows, lineCount: rawLines.length };
}

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('解析器自检：能认出 index.html 的模块级变量', () => {
  const { moduleLevel, lineCount } = analyse(html);
  // 解析器要是坏了（比如正则被改错），这两条会先炸 —— 避免"检查通过"其实是没检查。
  for (const must of ['raw', 'ctrl', 'track', 'ride', 'mode', 'editPts', 'editDirty']) {
    assert.ok(moduleLevel.has(must), '模块级变量里应该有 ' + must + '，实际有：' + [...moduleLevel].sort().join(','));
  }
  assert.ok(lineCount > 500, '内联脚本应该有几百行，实际 ' + lineCount);
  assert.ok(moduleLevel.size >= 35 && moduleLevel.size <= 70, '模块级变量数量应在 35~70 之间，实际 ' + moduleLevel.size);
});

test('函数体内没有遮蔽模块级变量的局部声明', () => {
  const { shadows, moduleLevel } = analyse(html);
  const detail = shadows.map(s => '  第 ' + s.line + ' 行（深度 ' + s.depth + '）遮蔽了 ' + s.name + '：' + s.text).join('\n');
  assert.equal(
    shadows.length, 0,
    '发现 ' + shadows.length + ' 处变量遮蔽。这类 bug 不会报错，只会让某个函数读到错误的值：\n' + detail
    + '\n\n模块级变量共 ' + moduleLevel.size + ' 个。改法：给局部变量换个名字。'
  );
});
