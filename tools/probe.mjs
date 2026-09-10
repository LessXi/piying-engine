// 引擎自检：对着 example/ 跑像素级断言，确认「真实光影 / 镂空透光 / 暖黄 / 织纹」都成立。
//
// 用法：node tools/probe.mjs
// 依赖：tools/harness.mjs（零依赖的无头浏览器驱动，自带 CDP 客户端与 PNG 解码器）
import { withPage, readPNG, meanLuma, meanRGB, imageDiff, sleep } from './harness.mjs';

const TS = ['0.2', '2.0', '4.0', '6.0'];

const res = await withPage({
  page: 'example/index.html',
  width: 960, height: 540,
  readyTimeout: 120000,
  logConsole: true,
}, async (page) => {
  await page.waitReady();
  await sleep(1200);
  const qa0 = await page.eval('JSON.stringify(window.__qa())');
  console.log('boot:', qa0);

  const shots = [];
  for (const t of TS) {
    await page.eval(`window.__SET_TIME__(${t})`);
    await sleep(500);
    shots.push(await page.shot(`shots/probe-t${t}.png`));
  }
  const qa = JSON.parse(await page.eval('JSON.stringify(window.__qa())'));
  const logs = page.logs.filter((l) => /error|exception|ERROR/i.test(l));
  return { shots, qa, logs };
});

const fails = [];
const ok = (cond, msg, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(msg);
};

console.log(`\n投影体 ${res.qa.casters} 个 · WebGL2=${res.qa.webgl2} · 三角面 ${res.qa.stats.tris} · draw calls ${res.qa.stats.drawCalls}`);

// 0) 着色器与异常
{
  const shaderErr = res.logs.filter((l) => /ERROR:|Program Info Log|not compiled/i.test(l));
  ok(shaderErr.length === 0, '所有着色器编译通过', shaderErr[0] ? String(shaderErr[0]).slice(0, 160) : '');
  const exc = res.logs.filter((l) => /exception/i.test(l));
  ok(exc.length === 0, '无未捕获异常', exc[0] ? String(exc[0]).slice(0, 160) : '');
}

const imgs = res.shots.map(readPNG);
const W = imgs[0].width, H = imgs[0].height;
const lum = (im, x0, y0, x1, y1) => meanLuma(im, x0 * W, y0 * H, x1 * W, y1 * H, 2);

const im = imgs[0];
const centre = lum(im, 0.44, 0.40, 0.56, 0.60);
ok(centre > 0.20, '幕布被灯照亮', `中心亮度 ${(centre * 100).toFixed(1)}%`);

// 光晕：径向剖面（环带平均，忽略织纹/条纹的高频）
{
  const cx = 0.5 * W, cy = 0.5 * H;
  const prof = [];
  for (let k = 0; k < 7; k++) {
    const vals = [];
    for (let a = 0; a < 48; a++) {
      const ang = a / 48 * Math.PI * 2;
      for (let rr = k / 7; rr < (k + 1) / 7; rr += 0.02) {
        const x = cx + Math.cos(ang) * rr * 0.5 * W;
        const y = cy + Math.sin(ang) * rr * 0.5 * H;
        if (x < 20 || y < 20 || x > W - 20 || y > H - 20) continue;
        vals.push(meanLuma(im, x, y, x + 1, y + 1));
      }
    }
    prof.push(vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1));
  }
  ok(prof[0] > prof[6] * 1.15, '光晕在幕布边缘散开（中心亮于边缘）',
    prof.map((v) => v.toFixed(2)).join(' -> '));
}

// 剪影：在幕布范围内找最暗区域
let darkest = { l: 1, x: 0, y: 0 }, brightRef = 0;
{
  const N = 32, cells = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const fx = (i + 0.5) / N, fy = (j + 0.5) / N;
      if (fx < 0.08 || fx > 0.92 || fy < 0.10 || fy > 0.90) continue;
      cells.push({ l: meanLuma(im, i / N * W + 2, j / N * H + 2, (i + 1) / N * W - 2, (j + 1) / N * H - 2, 2), x: Math.round(fx * W), y: Math.round(fy * H) });
    }
  }
  const s = cells.slice().sort((a, b) => a.l - b.l);
  darkest = s[Math.floor(s.length * 0.05)];
  brightRef = s[Math.floor(s.length * 0.95)].l;
}
ok(darkest.l < brightRef * 0.80, '幕布上出现剪影（遮挡生效）',
  `最暗 ${(darkest.l * 100).toFixed(1)}% vs 最亮 ${(brightRef * 100).toFixed(1)}%，比 ${(darkest.l / Math.max(brightRef, 1e-4)).toFixed(2)}`);

// 镂空透光：暗区窗口里明显亮于暗区的像素占比
{
  const R2 = 46;
  const x0 = Math.max(0, darkest.x - R2), x1 = Math.min(W, darkest.x + R2);
  const y0 = Math.max(0, darkest.y - R2), y1 = Math.min(H, darkest.y + R2);
  const thr = darkest.l + (brightRef - darkest.l) * 0.45;
  let bright = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (meanLuma(im, x, y, x + 1, y + 1) > thr) bright++; n++; }
  const ratio = n ? bright / n : 0;
  ok(ratio > 0.02, '剪影内部存在镂空透光亮斑（光真的穿过孔洞）', `亮斑占比 ${(ratio * 100).toFixed(1)}%`);
}

// 暖黄
{
  const c = meanRGB(im, W * 0.40, H * 0.40, W * 0.60, H * 0.62, 2);
  ok(c[0] > c[2] * 1.25, '灯光是暖黄的', `R=${c[0].toFixed(3)} G=${c[1].toFixed(3)} B=${c[2].toFixed(3)}`);
}

// 织纹/褶皱的局部明暗
{
  let acc = 0, n = 0;
  for (let oy = 0; oy < 5; oy++) {
    for (let ox = 0; ox < 5; ox++) {
      const x0 = 0.12 * W + ox * 0.05 * W, y0 = 0.26 * H + oy * 0.07 * H;
      const vals = [];
      for (let y = y0; y < y0 + 0.05 * H; y++) for (let x = x0; x < x0 + 0.045 * W; x++) vals.push(meanLuma(im, x, y, x + 1, y + 1));
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      acc += Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
      n++;
    }
  }
  const sd = acc / n;
  ok(sd > 0.003, '幕布有织纹/褶皱的细微明暗', `局部标准差 ${(sd * 1000).toFixed(2)}‰`);
}

// 动画
ok(imageDiff(imgs[0], imgs[2]) > 0.002, '画面随时间变化（关节在动）',
  `帧间差 ${(imageDiff(imgs[0], imgs[2]) * 100).toFixed(2)}%`);

console.log(`\n========== 引擎自检: ${fails.length === 0 ? 'ALL PASS' : fails.length + ' FAILED'} ==========`);
for (const f of fails) console.log(' - ' + f);
process.exit(fails.length ? 1 : 0);
