#!/usr/bin/env node
// build: validate a change spec and inline it into one self-contained preview HTML.
// Usage: node build.mjs <spec.json> [-o preview.html] [--check]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');

const TYPES = new Set(['page', 'section', 'row', 'col', 'grid', 'card', 'form', 'list', 'item', 'nav', 'tabs', 'header', 'footer', 'sidebar', 'toolbar', 'panel', 'group', 'modal', 'drawer', 'popover', 'menu', 'button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio', 'toggle', 'upload', 'heading', 'text', 'image', 'table', 'chart', 'stat', 'badge', 'tag', 'icon', 'divider', 'placeholder']);
const OVERLAY = new Set(['modal', 'drawer', 'popover', 'menu']);
const CHANGES = new Set(['added', 'removed', 'modified', 'unchanged']);
const IA_ACTIONS = new Set(['open', 'close', 'navigate', 'toggle', 'show', 'hide', 'state', 'back']);
const ACTORS = new Set(['user', 'frontend', 'backend', 'db', 'external', 'system']);

function usage(code) {
  console.log('用法: node build.mjs <spec.json> [-o <out.html>] [--check]\n       node build.mjs --doctor   环境自检\n  默认输出到 spec 同目录的 preview.html；--check 只校验不生成。');
  process.exit(code);
}

const args = process.argv.slice(2);

async function doctorAll() {
  const { existsSync } = await import('node:fs');
  const checks = [];
  const ok = (label, extra) => { checks.push({ label, ok: true, extra: extra || '' }); };
  const bad = (label, extra) => { checks.push({ label, ok: false, extra: extra || '' }); };
  // Node 版本
  const [maj] = process.versions.node.split('.').map(Number);
  maj >= 18 ? ok('Node.js ≥ 18', 'v' + process.versions.node) : bad('Node.js ≥ 18', '当前 v' + process.versions.node);
  // 资产完整
  for (const f of ['assets/runtime.js', 'assets/style.css', 'assets/template.html', 'scripts/build.mjs', 'scripts/embed.mjs', 'scripts/apply-feedback.mjs', 'scripts/wrap-archify.mjs', 'scripts/extract-gorm.mjs']) {
    existsSync(join(here, '..', f)) ? ok('文件 ' + f) : bad('文件 ' + f, '缺失');
  }
  // 示例可构建
  const exSpec = join(here, '..', 'examples', 'demo-review', 'spec.json');
  if (existsSync(exSpec)) {
    try {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath, [join(here, 'build.mjs'), exSpec, '--check'], { encoding: 'utf8' });
      r.status === 0 ? ok('示例 spec 构建', r.stdout.trim()) : bad('示例 spec 构建', (r.stderr || r.stdout || '').trim().split('\n')[0]);
    } catch (e) { bad('示例 spec 构建', e.message); }
  } else bad('示例 spec', 'examples/demo-review/spec.json 缺失');
  // Archify 可选
  const archifyBin = join(process.env.HOME || '', '.agents', 'skills', 'archify', 'bin', 'archify.mjs');
  existsSync(archifyBin) ? ok('Archify（可选）', '已安装') : checks.push({ label: 'Archify（可选）', ok: true, extra: '未安装——sysflow 将使用泳道渲染' });
  // 输出
  console.log('design-change-review doctor\n');
  for (const c of checks) console.log((c.ok ? '[ok] ' : '[missing] ') + c.label + (c.extra ? ' — ' + c.extra : ''));
  const fails = checks.filter((c) => !c.ok).length;
  if (!fails) { console.log('\nAll checks passed.'); return; }
  console.error('\n✖ ' + fails + ' 项未通过'); process.exitCode = 1;
}

let specPath = null, out = null, checkOnly = false, noLintSiblings = args.includes('--no-lint-siblings'), doctor = args.includes('--doctor');
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o' || a === '--out') out = args[++i];
  else if (a === '--check') checkOnly = true;
  else if (a === '--doctor' || a === '--no-lint-siblings') continue;
  else if (a === '-h' || a === '--help') usage(0);
  else if (!specPath) specPath = a;
  else usage(2);
}
if (doctor) { await doctorAll(); process.exit(0); }
if (!specPath) usage(2);
specPath = resolve(specPath);

let raw;
try { raw = readFileSync(specPath, 'utf8'); } catch (e) { console.error('✖ 读不到 spec：' + specPath + '\n  ' + e.message); process.exit(1); }
let spec;
try { spec = JSON.parse(raw); } catch (e) {
  const m = /position (\d+)/.exec(e.message);
  let where = '';
  if (m) { const pos = Number(m[1]); const line = raw.slice(0, pos).split('\n').length; where = '（第 ' + line + ' 行附近）'; }
  console.error('✖ spec 不是合法 JSON' + where + '：' + e.message);
  process.exit(1);
}

const { errors, warnings, summary } = validate(spec);
for (const w of warnings) console.log('⚠ ' + w);
for (const e of errors) console.error('✖ ' + e);
console.log(summary);

// ---- R6 存量并入 lint: 同目录其他未实施 prototype spec 若已收录相同路由，本 spec 应并入而非新开 ----
if (!noLintSiblings) {
  try {
    const fsMod = await import('node:fs');
    const readdirSync = fsMod.readdirSync;
    // 扫描范围: spec 所在目录的同级 spec 文件 + .agents/jdr 下兄弟目录里的 spec*.json（R6 的漏洞正是"开新目录"——只扫同目录永远抓不到）
    const dir = dirname(specPath);
    // jdrRoot legacy var removed: walk-up logic above finds .agents/jdr from the spec dir
    // 同目录的 spec*.json 是同一设计的版本历史，不算 sibling；只扫 .agents/jdr 下兄弟目录的 live spec
    const candidates = [];
    let jdr = dirname(dir);
    while (jdr && basename(jdr) !== 'jdr' && jdr !== dirname(jdr)) jdr = dirname(jdr);
    if (basename(jdr) === 'jdr') {
      for (const d of readdirSync(jdr, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const sub = join(jdr, d.name);
        if (resolve(sub) === resolve(dir)) continue;
        // archive/ 是历史归档（已并入或废弃），不参与 R6；live spec 可能埋一层（<jdr>/<dir>/spec.json 或 <jdr>/<dir>/<design-name>/spec.json）
        const tryPush = (folder) => {
          try {
            for (const f of readdirSync(folder)) {
              if (f === 'spec.json' || /^spec-v\d+\.json$/.test(f)) candidates.push(join(folder, f));
            }
          } catch { /* unreadable dir */ }
        };
        if (d.name === 'archive') continue;
        tryPush(sub);
        try {
          for (const d2 of readdirSync(sub, { withFileTypes: true })) {
            if (d2.isDirectory() && d2.name !== 'archive') tryPush(join(sub, d2.name));
          }
        } catch { /* */ }
      }
    }
    const seen = new Set();
    const routesOf = (sp) => {
      const rs = new Set();
      for (const p of sp.pages || []) {
        const r = p.route || p.id;
        if (p.change && p.change !== 'unchanged') rs.add(String(r).split('?')[0]);
      }
      return rs;
    };
    const myRoutes = routesOf(spec);
    for (const cand of candidates) {
      const rp = resolve(cand);
      if (rp === specPath || seen.has(rp)) continue;
      seen.add(rp);
      let sib;
      try { sib = JSON.parse(readFileSync(rp, 'utf8')); } catch { continue; }
      if (sib.stage === 'done' || !Array.isArray(sib.pages)) continue;
      const overlap = [...routesOf(sib)].filter((r) => myRoutes.has(r));
      if (overlap.length) {
        console.error('✖ 格式红线R6: ' + rp + '（version ' + (sib.version ?? '?') + '·未实施' + (sib.stage === 'prototype' ? '' : '/' + sib.stage) + '）已收录路由 ' + overlap.join(', ') + '——本方案触达相同页面，应并入该 spec（version+1）而不是新开目录；两份 prototype 对同一页面各画未来 = 冲突计划。（确属独立可加 --no-lint-siblings 豁免）');
        errors.push('R6 sibling-route conflict');
      }
    }
  } catch { /* 目录不可读时静默跳过，不阻断 */ }
}
if (errors.length) { console.error('✖ 有 ' + errors.length + ' 个错误，未生成。'); process.exit(1); }
if (checkOnly) { console.log('✔ 校验通过'); process.exit(0); }

const template = readFileSync(join(assets, 'template.html'), 'utf8');
const css = readFileSync(join(assets, 'style.css'), 'utf8');
const runtime = readFileSync(join(assets, 'runtime.js'), 'utf8');
spec = injectReplicaUnits(spec);
// 校验: data-unit-miss
const missCount = JSON.stringify(spec).split('data-unit-miss').length - 1;
if (missCount) errors.push('复刻 HTML 里有 ' + missCount + ' 处 data-replica-unit 找不到对应改动单元（检查节点 id）');
const specJson = JSON.stringify(spec).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// ---- 复刻标注静态注入: data-replica-unit → 真实编号 + 变更色 ----
function computeUnitsBuild(spec) {
  const list = [];
  (spec.pages || []).forEach((p) => {
    if (p.change === 'added' || p.change === 'removed') { list.push({ key: p.id, page: p.id, id: p.id, change: p.change }); return; }
    const walk = (n) => { const ch = n.change || 'unchanged'; if (n !== p.root && ch !== 'unchanged') { list.push({ key: n.id, page: p.id, id: n.id, change: ch }); return; } (n.children || []).forEach(walk); };
    walk(p.root); (p.overlays || []).forEach(walk);
  });
  list.forEach((u, i) => { u.n = i + 1; });
  return list;
}
function unitOfBuild(spec, pid, nid) {
  const p = (spec.pages || []).find((x) => x.id === pid); if (!p) return null;
  const chain = []; const find = (n, par) => { if (!n) return false; if (n.id === nid) { chain.push(par, n); return true; } for (const c of (n.children || [])) { if (find(c, n)) { chain.push(par); return true; } } return false; };
  // 简化: 收集 root→nid 路径
  const path = []; const dfs = (n) => { if (!n) return false; path.push(n); if (n.id === nid) return true; for (const c of (n.children || [])) if (dfs(c)) return true; path.pop(); return false; };
  let found = dfs(p.root);
  if (!found) { for (const ov of (p.overlays || [])) { path.length = 0; if (dfs(ov)) { found = true; break; } } }
  if (!found) return null;
  const top = path.filter((x) => x !== p.root && x.change && x.change !== 'unchanged')[0] || null;
  return top ? top.id : null;
}
function injectReplicaUnits(spec) {
  const units = computeUnitsBuild(spec);
  (spec.pages || []).forEach((p) => {
    ['htmlBefore', 'htmlAfter'].forEach((hk) => {
      let html = p[hk];
      if (!html || html.indexOf('data-replica-unit') < 0) return;
      const side = hk === 'htmlBefore' ? 'before' : 'after';
      html = html.replace(/data-replica-unit="([^"]+)"/g, (m, nid) => {
        let u = units.find((x) => x.page === p.id && x.id === nid);
        if (!u) { const uid = unitOfBuild(spec, p.id, nid); if (uid) u = units.find((x) => x.page === p.id && x.id === uid); }
        if (!u) return m + ' data-unit-miss="1"'; // 绑定缺失, 校验器报错
        const sideOk = !(u.change === 'added' && side === 'before') && !(u.change === 'removed' && side === 'after');
        const zh = u.change === 'added' ? '新增' : u.change === 'removed' ? '删除' : '修改';
        return m + ' data-unit-n="' + u.n + '" data-unit-chg="' + u.change + '" data-unit-chg-zh="' + zh + '"' + (sideOk ? '' : ' data-unit-side-miss="1"');
      });
      p[hk] = html;
    });
    // overlays 的 html 变体也处理(若有)
    (p.overlays || []).forEach((ov) => {
      ['htmlBefore', 'htmlAfter'].forEach((hk) => {
        let html = ov[hk];
        if (!html || html.indexOf('data-replica-unit') < 0) return;
        const side = hk === 'htmlBefore' ? 'before' : 'after';
        html = html.replace(/data-replica-unit="([^"]+)"/g, (m, nid) => {
          let u = units.find((x) => x.page === p.id && x.id === nid);
          if (!u) { const uid = unitOfBuild(spec, p.id, nid); if (uid) u = units.find((x) => x.page === p.id && x.id === uid); }
          if (!u) return m + ' data-unit-miss="1"';
          return m + ' data-unit-n="' + u.n + '" data-unit-chg="' + u.change + '"';
        });
        ov[hk] = html;
      });
    });
  });
  return spec;
}

const html = template
  .replace('__TITLE__', () => escapeHtml((spec.title || '方案变更') + ' · 变更预览'))
  .replace('/*__STYLE__*/', () => css)
  .replace('/*__RUNTIME__*/', () => runtime.replace(/<\/script/gi, '<\\/script'))
  .replace('__SPEC__', () => specJson);
const outPath = resolve(out || join(dirname(specPath), 'preview.html'));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);
console.log('✔ 已生成 ' + outPath + '（' + Math.round(html.length / 1024) + ' KB）');
console.log('  ' + pathToFileURL(outPath).href);

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function validate(spec) {
  const errors = [], warnings = [];
  const z = () => ({ added: 0, removed: 0, modified: 0 });
  const cnt = { pages: z(), nodes: z(), steps: z(), be: z() };
  const bump = (b, o) => { if (o && b[o.change] !== undefined) b[o.change]++; };
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { errors: ['spec 顶层必须是 JSON 对象'], warnings, summary: '' };
  if (!spec.title) warnings.push('缺少 title（预览标题）');
  if (spec.stage && !['prototype', 'implementing', 'done'].includes(spec.stage)) warnings.push('stage 应为 prototype / implementing / done，收到 "' + spec.stage + '"');
  for (const k of ['pages', 'flows', 'backend', 'changes', 'questions']) if (spec[k] !== undefined && !Array.isArray(spec[k])) errors.push(k + ' 必须是数组');
  const ids = new Map();
  const iaRefs = [];
  const reg = (o, where) => {
    if (o.id == null) return;
    const k = String(o.id);
    if (ids.has(k)) errors.push('重复的 id "' + k + '"：' + ids.get(k) + ' 与 ' + where + '（id 在整个 spec 内必须唯一）');
    else ids.set(k, where);
  };
  const chk = (o, where) => {
    if (o.change != null && !CHANGES.has(o.change)) errors.push(where + '：change 只能是 added / removed / modified / unchanged，收到 "' + o.change + '"');
    if (o.before != null && (typeof o.before !== 'object' || Array.isArray(o.before))) errors.push(where + '：before 必须是对象（旧字段值）');
    if (o.before && o.change !== 'modified' && o.change !== 'removed' && o.change !== 'unchanged') warnings.push(where + '：写了 before 但 change 不是 modified，左侧仍会按 before 显示');
    if (o.change === 'modified' && !o.before && !o.note) warnings.push(where + '：change=modified 但既没有 before 也没有 note，用户看不出改了什么');
  };
  const pages = Array.isArray(spec.pages) ? spec.pages : [];
  for (const p of pages) {
    const pw = '页面「' + (p.name || p.id || '?') + '」';
    if (!p || typeof p !== 'object') { errors.push('pages 里有非对象元素'); continue; }
    reg(p, pw); chk(p, pw); bump(cnt.pages, p);
    if (!p.root || typeof p.root !== 'object') { errors.push(pw + '：缺少 root 节点'); continue; }
    const pageIds = new Set(), triggers = [], moves = [], placeholders = [];
    if (p.width != null && !(Number(p.width) >= 320)) warnings.push(pw + '：width 应为画布宽度像素（≥ 320），默认 1280');
    const walk = (n, parent, where0) => {
      if (!n || typeof n !== 'object' || Array.isArray(n)) { errors.push(where0 + '：children 里有非对象元素'); return; }
      const where = pw + ' › ' + (n.label || n.type || '?') + (n.id ? ' #' + n.id : '');
      reg(n, where); chk(n, where); if (n !== p.root) bump(cnt.nodes, n);
      if (n.id != null) pageIds.add(String(n.id)); else warnings.push(where + '：没有 id（会自动生成，但反馈里引用不稳定，建议补上）');
      if (n.type && !TYPES.has(n.type)) warnings.push(where + '：未知组件类型 "' + n.type + '"，将按通用方框显示');
      if (n.before && n.before.children) errors.push(where + '：before 里不能放 children；子元素的增删请标在子元素自己身上');
      if (n.children !== undefined && !Array.isArray(n.children)) errors.push(where + '：children 必须是数组');
      if (parent && parent.change === 'removed' && n.change === 'added') warnings.push(where + '：父元素被删除，子元素却标为新增，右侧不会显示它');
      if (parent && parent.change === 'added' && n.change === 'removed') warnings.push(where + '：父元素是新增的，子元素却标为删除，左侧不会显示它');
      if (n.trigger != null && !(typeof n.trigger === 'string' || (Array.isArray(n.trigger) && n.trigger.every((x) => typeof x === 'string')))) errors.push(where + '：trigger 必须是元素 id 字符串，或 id 数组（多个按钮打开同一个弹层）');
      for (const t of n.trigger == null ? [] : (Array.isArray(n.trigger) ? n.trigger : [n.trigger])) triggers.push([String(t), where]);
      if (n.trigger && !OVERLAY.has(n.type)) warnings.push(where + '：只有 modal / drawer / popover / menu 才需要 trigger');
      if (n.movedFrom) moves.push([String(n.movedFrom), where, 'movedFrom']);
      if (n.movedTo) moves.push([String(n.movedTo), where, 'movedTo']);
      if (n.movedFrom && n.change !== 'added') warnings.push(where + '：有 movedFrom 的元素应标为 change=added');
      if (n.movedTo && n.change !== 'removed') warnings.push(where + '：有 movedTo 的元素应标为 change=removed');
      for (const key of ['items', 'columns']) if (n[key] !== undefined && !Array.isArray(n[key])) errors.push(where + '：' + key + ' 必须是数组');
      if (n.on !== undefined) {
        if (!Array.isArray(n.on)) errors.push(where + '：on 必须是数组，如 [{ "action": "open", "target": "xxx" }]');
        else n.on.forEach((x) => {
          const act = x && (x.action || x.do);
          if (!act || !IA_ACTIONS.has(act)) errors.push(where + '：on 的 action 只能是 open / close / navigate / toggle / show / hide / state / back，收到 "' + act + '"');
          else if (['open', 'navigate', 'toggle', 'show', 'hide'].includes(act) && !x.target) errors.push(where + '：action ' + act + ' 需要 target');
          if (x && x.target) iaRefs.push([String(x.target), act, where, x.state]);
          if (act === 'state' && !x.target) iaRefs.push([String(n.id), act, where, x.state]);
        });
      }
      if (n.hidden !== undefined && typeof n.hidden !== 'boolean') errors.push(where + '：hidden 必须是 true / false');
      if (n.states !== undefined && (!n.states || typeof n.states !== 'object' || Array.isArray(n.states))) errors.push(where + '：states 必须是对象，如 { "done": { "label": "已验收" } }');
      if (n.state != null && !(n.states && n.states[n.state])) warnings.push(where + '：state "' + n.state + '" 不在 states 里');
      if (!n.on && !n.hidden && !n.states && /点了.{0,8}才|点击后.{0,4}出现|才出现|点不开|可折叠|点开看/.test(String(n.label || '') + String(n.text || ''))) warnings.push(where + '：文字里在描述交互（「…才出现」「点不开」「可折叠」），改用 on / hidden / states，用户在「▶ 演示」里就能真的点');
      if (n.component != null && typeof n.component !== 'string') errors.push(where + '：component 必须是字符串（代码里的组件名 / 文件）');
      if (n.type === 'placeholder' && /不变|同上|其余|省略/.test(String(n.label || ''))) placeholders.push(where);
      (Array.isArray(n.children) ? n.children : []).forEach((c) => walk(c, n, where));
    };
    walk(p.root, null, pw);
    if (p.overlays !== undefined && !Array.isArray(p.overlays)) errors.push(pw + '：overlays 必须是数组');
    (Array.isArray(p.overlays) ? p.overlays : []).forEach((o) => {
      walk(o, null, pw + ' › 弹层');
      if (o && o.type && !OVERLAY.has(o.type)) warnings.push(pw + ' › 弹层 #' + o.id + '：overlays 里的元素通常是 modal / drawer / popover / menu');
      if (o && (!o.trigger || (Array.isArray(o.trigger) && !o.trigger.length))) warnings.push(pw + ' › 弹层「' + (o.label || o.id) + '」：没有 trigger，用户看不出它由哪个按钮打开');
    });
    for (const [t, where] of triggers) if (!pageIds.has(t)) iaRefs.push([t, 'trigger', where]);
    if (placeholders.length) warnings.push(pw + '：有 ' + placeholders.length + ' 个「（不变）」占位框。没改动的模块也要画成真实模块：写它在界面上的名字 + component，不展开 children 即可（会显示「内容不变，未展开」）');
    if (!JSON.stringify(p.root).includes('"component"')) warnings.push(pw + '：没有任何节点写 component。顶层区域（侧栏、主栏、面板…）请标上代码里的组件名，用户才能把框和真实模块对上');
    for (const [t, where, k] of moves) if (!pageIds.has(t)) warnings.push(where + '：' + k + ' "' + t + '" 在本页面找不到');
  }
  const flows = Array.isArray(spec.flows) ? spec.flows : [];
  const allNodeIds = new Set();
  const nodeById = new Map();
  for (const p of pages) { const walk = (n) => { if (n && typeof n === 'object' && n.id != null) nodeById.set(String(n.id), n); if (n && typeof n === 'object') (Array.isArray(n.children) ? n.children : []).forEach(walk); }; walk(p.root); (Array.isArray(p.overlays) ? p.overlays : []).forEach(walk); }
  for (const [t, act, where, st] of iaRefs) {
    if (act === 'navigate') { if (!pages.some((p) => p.id === t)) warnings.push(where + '：navigate 的 target "' + t + '" 不是页面 id'); continue; }
    const tn = nodeById.get(t);
    if (!tn) { warnings.push(where + '：' + (act === 'trigger' ? 'trigger' : act + ' 的 target') + ' "' + t + '" 找不到'); continue; }
    if (act === 'state' && st != null && !(tn.states && tn.states[st])) warnings.push(where + '：目标 #' + t + ' 没有状态 "' + st + '"（先在它的 states 里写上）');
  }
  for (const p of pages) { const walk = (n) => { if (n && typeof n === 'object') { if (n.id != null) allNodeIds.add(String(n.id)); (Array.isArray(n.children) ? n.children : []).forEach(walk); } }; walk(p.root); (Array.isArray(p.overlays) ? p.overlays : []).forEach(walk); }
  for (const f of flows) {
    const fw = '流程「' + (f.name || f.id || '?') + '」';
    reg(f, fw); chk(f, fw);
    if (!Array.isArray(f.steps)) { errors.push(fw + '：steps 必须是数组'); continue; }
    for (const s of f.steps) {
      const sw = fw + ' › 步骤「' + (s.text || s.id || '?') + '」';
      reg(s, sw); chk(s, sw); bump(cnt.steps, s);
      if (s.actor && !ACTORS.has(s.actor)) warnings.push(sw + '：actor "' + s.actor + '" 不是常用值（user / frontend / backend / db / external / system），会作为自定义泳道显示');
      if (s.page && !pages.some((p) => p.id === s.page)) warnings.push(sw + '：page "' + s.page + '" 不存在');
      for (const ref of s.node == null ? [] : (Array.isArray(s.node) ? s.node : [s.node])) if (!allNodeIds.has(String(ref))) warnings.push(sw + '：node "' + ref + '" 在页面里找不到');
    }
  }
  const backend = Array.isArray(spec.backend) ? spec.backend : [];
  for (const m of backend) {
    const mw = '后端模块「' + (m.name || m.id || '?') + '」';
    reg(m, mw); chk(m, mw); bump(cnt.be, m);
    if (m.items !== undefined && !Array.isArray(m.items)) { errors.push(mw + '：items 必须是数组'); continue; }
    for (const it of m.items || []) { const iw = mw + ' › ' + (it.name || it.id || '?'); reg(it, iw); chk(it, iw); bump(cnt.be, it); }
  }
  // 扩展池: datachanges / middleware / sysflows (跨池 id 冲突检查复用 reg)
  const datachanges = Array.isArray(spec.datachanges) ? spec.datachanges : [];
  for (const m of datachanges) {
    const dw = '数据库模块「' + (m.name || m.id || '?') + '」';
    reg(m, dw); chk(m, dw);
    if (m.items !== undefined && !Array.isArray(m.items)) { errors.push(dw + '：items 必须是数组'); continue; }
    for (const it of m.items || []) { const iw = dw + ' › ' + (it.table || it.name || it.id || '?'); reg(it, iw); chk(it, iw); }
  }
  const middleware = Array.isArray(spec.middleware) ? spec.middleware : [];
  for (const m of middleware) {
    const ww = '中间件模块「' + (m.name || m.id || '?') + '」';
    reg(m, ww); chk(m, ww);
    if (m.items !== undefined && !Array.isArray(m.items)) { errors.push(ww + '：items 必须是数组'); continue; }
    for (const it of m.items || []) { const iw = ww + ' › ' + (it.name || it.id || '?'); reg(it, iw); chk(it, iw); }
  }
  const sysflows = Array.isArray(spec.sysflows) ? spec.sysflows : [];
  for (const m of sysflows) { reg(m, '系统流程「' + (m.name || m.id || '?') + '」'); }
  // 引用闭合: trigger / on.target / flow node 必须指向存在的 id
  {
    const ids2 = new Set();
    const collect = (o) => {
      if (o && typeof o === 'object') {
        if (o.id != null) ids2.add(String(o.id));
        for (const v of Object.values(o)) collect(v);
      } else if (Array.isArray(o)) { for (const x of o) collect(x); }
    };
    collect(spec);
    const checkRef = (ref, where) => { if (ref != null && String(ref) !== '' && !ids2.has(String(ref))) errors.push(where + '：引用了不存在的 id #' + ref + '（悬空引用）'); };
    for (const pg of pages) {
      const walkRef = (n, where) => {
        if (!n || typeof n !== 'object') return;
        const t = n.trigger;
        if (t) for (const x of (Array.isArray(t) ? t : [t])) checkRef(x, where + ' trigger');
        for (const ia of n.on || []) { if (ia && ia.target && ia.action !== 'close' && ia.action !== 'back') checkRef(ia.target, where + ' on.target'); }
        for (const c of n.children || []) walkRef(c, where);
      };
      walkRef(pg.root, '页面「' + (pg.name || pg.id) + '」');
      for (const ov of pg.overlays || []) { if (ov.trigger) for (const x of (Array.isArray(ov.trigger) ? ov.trigger : [ov.trigger])) checkRef(x, '弹层「' + (ov.label || ov.id) + '」trigger'); }
    }
    for (const f of flows.concat(sysflows)) for (const s of f.steps || []) { if (s && s.node) for (const x of (Array.isArray(s.node) ? s.node : [s.node])) checkRef(x, '流程「' + (f.name || f.id) + '」步骤 node'); }
  }
  // modified 上下文: 变更条目必须带 before 或 note(扩展池)
  for (const pool of [['backend', backend], ['datachanges', datachanges], ['middleware', middleware]]) {
    for (const m of pool[1]) for (const it of m.items || []) {
      if (it.change === 'modified' && !it.before && !it.note) warnings.push(pool[0] + ' 条目「' + (it.table || it.name || it.id) + '」：change=modified 但没有 before/note，看不出改了什么');
    }
  }
  const f = (b) => '+' + b.added + ' −' + b.removed + ' ~' + b.modified;
  const summary = '· 页面 ' + pages.length + '（' + f(cnt.pages) + '）· 界面元素变化 ' + f(cnt.nodes) + ' · 流程 ' + flows.length + '（步骤 ' + f(cnt.steps) + '）· 后端 ' + backend.length + ' 个模块（' + f(cnt.be) + '）';
  if (!pages.length && !flows.length && !backend.length) warnings.push('spec 里没有 pages / flows / backend，预览将是空的');

  // ---- v1.5 htmlOverlay-only 覆盖层提示（画布空抽屉回退教训）----
  for (const p of pages) for (const o of p.overlays || []) {
    const hasKids = (o.children || []).length > 0 || (o.items || []).length > 0;
    if (o.htmlOverlay && !hasKids && o.change !== 'removed') {
      warnings.push('弹层「' + (o.name || o.id) + '」只有 htmlOverlay 没有 wireframe children——画布态会显示骨架占位(v1.5 起带「在演示里看内容」按钮); 建议补 children 让画布也有结构');
    }
  }
  // ---- v1.3 格式红线 lint（2026-11-16 软件市场回退教训，机器兜底代替 agent 自觉）----
  // 红线只对 prototype 阶段生效（stage=done 的回顾可以无截图无 0 改动页）。
  const isPrototype = spec.stage !== 'done';
  if (isPrototype) {
    // R1 证据红线: 涉及「修改/删除已有页面」的方案，spec 树里必须至少 1 个 image 节点（现状真机截图入树）。
    const hasImageNode = pages.some((p) => JSON.stringify(p.root || {}).includes('"type":"image"') || JSON.stringify(p.root || {}).includes('"type": "image"'));
    const touchesExisting = pages.some((p) => p.change === 'modified' || p.change === 'removed');
    if (touchesExisting && !hasImageNode) {
      errors.push('格式红线R1: 有 modified/removed 页面但树内 0 个 image 节点——现状真机截图必须挂进 spec（evidence/ 截了不算，入树才算），否则评审看不到「改动前」');
    }
    // R2 上下文红线: 改动页 ≥3 时，至少 1 个 change 缺省/unchanged 的上下文页（0 改动锚点），防「全绿新增」式方案失去对照。
    const changedPages = pages.filter((p) => p.change && p.change !== 'unchanged').length;
    const ctxPages = pages.filter((p) => !p.change || p.change === 'unchanged').length;
    if (changedPages >= 3 && ctxPages === 0) {
      warnings.push('格式红线R2(建议): ' + changedPages + ' 个改动页但没有任何「0 改动」上下文页——补 1-2 个相邻现状页（route+截图）做对照锚点（1112 标杆格式）');
    }
    // R3 modified 条目必须可辨识: 页面级 change=modified 时 before 或 note 至少其一（与池条目同标准）。
    for (const p of pages) {
      if (p.change === 'modified' && !p.before && !p.note) warnings.push('页面「' + (p.name || p.id) + '」change=modified 但没有 before/note');
    }
  }
  // ---- R8 系统流程必选 Archify（对所有 stage 生效）----
  // 判定 Archify 可用性（与 --doctor 同源：~/.agents/skills/archify/bin/archify.mjs）
  const archifyAvailable = (() => {
    try {
      const bin = join(process.env.HOME || '', '.agents', 'skills', 'archify', 'bin', 'archify.mjs');
      return existsSync(bin);
    } catch { return false; }
  })();
  const lanesOnly = sysflows.filter((s) => !s.embedHtml && Array.isArray(s.steps) && s.steps.length);
  if (sysflows.length && lanesOnly.length && archifyAvailable) {
    // 可用却降级：要求逐条理由，否则警告未完成品（不阻断——旧 spec 平滑迁移，新 spec 应消灭此警告）
    const noReason = lanesOnly.filter((s) => !(s.note && /archify|降级|不可用|暂不|理由/i.test(s.note)));
    if (noReason.length) {
      warnings.push('格式红线R8: ' + noReason.length + ' 条 sysflow 是纯泳道 steps 而本机 Archify 可用——按 R8 应为 embedHtml（archify render→check→wrap）；确需泳道请在每条 sysflow 的 note 写明不用 Archify 的理由。涉及: ' + noReason.map((s) => s.id).join(', '));
    }
  }
  if (sysflows.length && lanesOnly.length && !archifyAvailable) {
    warnings.push('格式红线R8(降级放行): 本机未安装 Archify，' + lanesOnly.length + ' 条 sysflow 以泳道 steps 交付——安装后应升级为 embedHtml');
  }
  return { errors, warnings, summary };
}
