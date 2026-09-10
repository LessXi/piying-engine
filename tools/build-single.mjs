// 构建自包含单文件 index.html：把 three.js 与引擎模块内联进一个经典 <script>。
//
// 为什么需要它：**浏览器不允许从 file:// 加载 ES module**
//   Access to script at 'file:///…/src/…js' from origin 'null' has been blocked by CORS policy
// 所以 example/index.html 只能通过 http 服务打开（npx serve . 之类）。
// 想让别人「双击就能看」，就跑这个脚本，把示例整站内联成一个 index.html。
//
//   node tools/build-single.mjs
//
// 流程：example/index.html 里 <script type="module"> 的代码会被抽到 example/main.js，
//       再连同引擎模块一起内联。抽取是幂等的。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
const EX = 'example/index.html';
const TPL = 'example/index.single.template.html';
const MAIN = 'example/main.js';
const OUT = 'index.html';

/* ---- 1) 把 example/index.html 抽成「模板 + main.js」 ---- */
{
  const src = fs.readFileSync(EX, 'utf8');
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(src);
  if (!m) throw new Error('example/index.html 里找不到 <script type="module">');
  const code = m[1].trim() + '\n';
  fs.writeFileSync(MAIN, code, 'utf8');
  let tpl = src.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
  tpl = tpl.replace(/<script type="module">[\s\S]*?<\/script>/, '<!--BUNDLE-->');
  fs.writeFileSync(TPL, tpl, 'utf8');
  console.log(`抽取：example/main.js ${(code.length / 1024).toFixed(1)} KB → ${TPL}`);
}

/* ---- 2) 打包 ---- */
const ORDER = [
  'vendor/three.module.js',
  'src/engine/textures.js',
  'src/engine/materials.js',
  'src/engine/rig.js',
  'src/engine/shapes.js',
  'src/engine/screen.js',
  'src/engine/compositor.js',
  'src/engine/renderer.js',
  'src/engine/stage.js',
  'example/main.js',
];

const modId = (i, rel) => `__m${i}_${path.basename(rel).replace(/[^a-zA-Z0-9]/g, '_')}`;

function parseModule(code) {
  const exports = new Set();
  let body = code
    .replace(/\/\/#\s*sourceMappingURL=.*$/gm, '')
    .replace(/^[ \t]*export\s*\{([^}]*)\}\s*(?:from\s*['"][^'"]+['"]\s*)?;?[ \t]*$/gm, (m, names) => {
      for (const part of names.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const as = t.split(/\s+as\s+/);
        exports.add((as[1] || as[0]).trim());
      }
      return '';
    })
    .replace(/^([ \t]*)export\s+default\s+/gm, (m, ind) => { exports.add('__default'); return ind + 'const __default = '; })
    .replace(/^([ \t]*)export\s+(const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/gm,
      (m, ind, kind, name) => { exports.add(name); return `${ind}${kind} ${name}`; });

  const imports = [];
  {
    const out = [];
    const srcLines = body.split('\n');
    for (let i = 0; i < srcLines.length; i++) {
      const line = srcLines[i];
      if (!/^[ \t]*import\b/.test(line)) { out.push(line); continue; }
      let stmt = line, j = i;
      while (!/;\s*$/.test(stmt) && !/from\s*['"][^'"]+['"]\s*;?\s*$/.test(stmt) && j + 1 < srcLines.length) {
        j++; stmt += '\n' + srcLines[j];
      }
      i = j;
      const fromM = /from\s*['"]([^'"]+)['"]/.exec(stmt);
      if (!fromM) continue;
      const spec = fromM[1];
      const clause = stmt.replace(/^[ \t]*import\s*/, '').replace(/from[\s\S]*$/, '').trim();
      for (const p of clause.replace(/[{}]/g, ' ').split(',').map((s) => s.trim()).filter(Boolean)) {
        if (p.startsWith('*')) { imports.push({ ns: p.replace(/^\*\s*as\s*/, '').trim(), mod: spec }); continue; }
        const as = p.split(/\s+as\s+/);
        imports.push({ name: (as[1] || as[0]).trim(), orig: as[0].trim(), mod: spec });
      }
    }
    body = out.join('\n');
  }
  return { body, exports, imports };
}

const byPath = new Map();
const mods = [];
ORDER.forEach((rel, i) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error('缺少文件: ' + rel);
  const parsed = parseModule(fs.readFileSync(abs, 'utf8'));
  const norm = rel.replace(/\\/g, '/');
  const m = { rel: norm, idx: i, id: modId(i, rel), ...parsed };
  mods.push(m);
  byPath.set(norm, m);
});

const resolveSpec = (fromRel, spec) => {
  if (spec === 'three') return byPath.get('vendor/three.module.js');
  if (!spec.startsWith('.')) return byPath.get(spec);
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (byPath.has(p)) return byPath.get(p);
  if (byPath.has(p + '.js')) return byPath.get(p + '.js');
  const b = path.posix.basename(p).replace(/\.js$/, '') + '.js';
  for (const mm of mods) if (path.posix.basename(mm.rel) === b) return mm;
  return null;
};

const chunks = [];
for (const m of mods) {
  const lines = [];
  for (const imp of m.imports) {
    const target = resolveSpec(m.rel, imp.mod);
    if (!target) throw new Error(`${m.rel}: 找不到 import "${imp.mod}"`);
    if (imp.ns) { lines.push(`const ${imp.ns} = ${target.id};`); continue; }
    if (target.exports.size > 0 && !target.exports.has(imp.orig)) {
      throw new Error(`${m.rel}: ${imp.mod} 没有导出 "${imp.orig}"`);
    }
    lines.push(`const ${imp.name} = ${target.id}.${imp.orig};`);
  }
  const exportObj = m.exports.size ? `\nreturn { ${Array.from(m.exports).join(', ')} };` : '\nreturn {};';
  chunks.push(`/* ==================== ${m.rel} ==================== */\n` +
    `const ${m.id} = (function(){\n${lines.join('\n')}\n${m.body}${exportObj}\n})();`);
}

const bundle = `(function(){\n'use strict';\n${chunks.join('\n\n')}\n})();`;
const nScript = (bundle.match(/<\/script/gi) || []).length;
const nComment = (bundle.match(/<!--/g) || []).length;
const htmlSafe = bundle.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

try {
  new vm.Script(bundle, { filename: 'bundle.js' });
  new vm.Script(htmlSafe, { filename: 'htmlsafe.js' });
} catch (e) {
  console.error('\n打包结果有语法错误：' + e.message);
  for (const m of mods) {
    try { new vm.Script(`(function(){\n${chunks[m.idx]}\n})();`, { filename: m.rel }); }
    catch (e2) { console.error(`  ✗ 模块 ${m.rel}: ${e2.message}`); }
  }
  process.exit(1);
}

const html = fs.readFileSync(TPL, 'utf8');
const marker = '<!--BUNDLE-->';
if (!html.includes(marker)) throw new Error(TPL + ' 里找不到 ' + marker);

// ★ 函数式替换：字符串式会被内容里的 $& / $' 破坏（踩过坑）
const finalHtml = html.replace(marker, () => `<script>\n${htmlSafe}\n</script>`);
const opens = (finalHtml.match(/<script>/g) || []).length;
const closes = (finalHtml.match(/<\/script>/g) || []).length;
if (opens !== closes) { console.error(`script 标签不配对: ${opens} / ${closes}`); process.exit(1); }

fs.writeFileSync(path.join(ROOT, 'index.bundle.js'), bundle, 'utf8');
fs.writeFileSync(path.join(ROOT, OUT), finalHtml, 'utf8');
console.log(`语法自检 OK（转义 ${nScript} 处 </script、${nComment} 处 <!--；script 标签 ${opens}/${closes} 配对）`);
console.log(`模块 ${mods.length} 个 → 写出 ${OUT}  ${(finalHtml.length / 1024).toFixed(0)} KB（自包含单文件）`);
