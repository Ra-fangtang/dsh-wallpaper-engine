#!/usr/bin/env node
/**
 * 发行前自检：让「打标签发版」这件事只依赖一条命令。
 *
 *   node scripts/verify.mjs            # 只做静态校验
 *   node scripts/verify.mjs --pack     # 再打一个 release 用的 tarball 并列出内容
 *   node scripts/verify.mjs --pack --tag   # 校验通过后打 git 标签 v<version>
 *
 * 不依赖任何第三方包：只跑 node --check、读自己的 package.json、以及 npm pack
 * （npm / pnpm 都在时优先用 pnpm，二者都没有就只能跳过打包那一步）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))

const problems = []
const notes = []

function ok (line) { console.log('  \u2713 ' + line) }
function bad (line) { problems.push(line); console.log('  \u2717 ' + line) }
function note (line) { notes.push(line); console.log('  \u00b7 ' + line) }

function read (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

// ---------------------------------------------------------------------------
// 1. 打包清单里的每个文件都得存在
// ---------------------------------------------------------------------------
console.log('打包清单')
const pkg = JSON.parse(read('package.json'))
for (const rel of [...pkg.files, 'package.json']) {
  if (fs.existsSync(path.join(ROOT, rel))) ok(rel)
  else bad('清单里的 ' + rel + ' 不存在')
}

// ---------------------------------------------------------------------------
// 2. 前端脚本与宿主模块的语法
// ---------------------------------------------------------------------------
console.log('语法')
for (const rel of ['lib/index.js', 'lib/scene-pkg.js', 'assets/wallpaper-client.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' })
    ok(rel)
  } catch (error) {
    bad(rel + ' 语法错误：' + String(error.stderr || error.message).trim().split('\n')[0])
  }
}

// ---------------------------------------------------------------------------
// 3. 宿主模块真的能被 import（bundle 挂载靠的就是这个默认导出）
// ---------------------------------------------------------------------------
console.log('宿主模块')
try {
  const mod = await import('file:///' + path.join(ROOT, 'lib/index.js').replace(/\\/g, '/'))
  if (typeof mod.default === 'object' && mod.default && typeof mod.default.apply === 'function') {
    ok('默认导出带 apply()，name=' + mod.default.name)
  } else {
    bad('默认导出不是 { name, apply(ctx) } 形状')
  }
  if (mod.internals && typeof mod.internals.sanitizeConfig === 'function') {
    const cleaned = mod.internals.sanitizeConfig({ skinAlpha: 0.4, skinCompat: false, bogus: 1 })
    if (cleaned.skinAlpha === 0.4 && cleaned.skinCompat === false && !('bogus' in cleaned)) ok('配置清洗照旧只放行已知字段')
    else bad('配置清洗结果不对：' + JSON.stringify(cleaned))
  }
} catch (error) {
  bad('导入失败：' + error.message)
}

// ---------------------------------------------------------------------------
// 4. package.json 的元数据与组合包声明
// ---------------------------------------------------------------------------
console.log('元数据')
if (pkg.repository && /dsh-wallpaper-engine\.git$/.test(pkg.repository.url)) ok('repository 指向本仓库')
else bad('repository 不对：' + JSON.stringify(pkg.repository))
if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) {
  const patch = path.join(ROOT, pkg.dsh.bundle.patch)
  if (fs.existsSync(patch)) ok('dsh.bundle.patch -> ' + pkg.dsh.bundle.patch)
  else bad('dsh.bundle.patch 指向的文件不存在：' + pkg.dsh.bundle.patch)
} else {
  bad('缺少 dsh.bundle.patch，装上去不会被当成组合包')
}
// 无依赖、无生命周期脚本是刻意的：git 安装时 pnpm 会拦构建脚本要求授权，
// 本插件没有构建步骤，所以一律不该出现。
for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  const value = pkg[field]
  if (value && Object.keys(value).length) bad(field + ' 不该有内容：' + JSON.stringify(value))
}
if (pkg.scripts && pkg.scripts.prepare) bad('不该声明 prepare（git 安装会触发 pnpm 构建脚本审批）')
else ok('无依赖、无 prepare：从源码安装不需要构建脚本授权')
if (pkg.dsh && pkg.dsh.engines && pkg.dsh.engines.dsh) note('dsh.engines.dsh = ' + pkg.dsh.engines.dsh + '（仅说明用途；DSH 真正校验的是 peerDependencies，本插件不声明）')

// ---------------------------------------------------------------------------
// 5. 别把机器私有信息发出去
// ---------------------------------------------------------------------------
console.log('脱敏')
const PRIVATE = [
  [/C:\\Users\\[^\\\s]+/i, 'Windows 用户目录'],
  [/D:\\Plugins/i, '本机插件目录'],
  [/\bI:\\SteamLibrary/i, '本机 Steam 库盘符'],
  [/@users\.noreply\.github\.com/, null], // 允许（提交身份）
  [/[A-Za-z]:\\Users\\[^\\\s]+\.ssh/i, 'ssh 路径'],
]
for (const rel of ['README.md', 'lib/index.js', 'lib/scene-pkg.js', 'assets/wallpaper-client.js']) {
  const text = read(rel)
  let hit = false
  for (const [re, label] of PRIVATE) {
    if (!label) continue
    const m = re.exec(text)
    if (m) { bad(rel + ' 里出现' + label + '：' + m[0]); hit = true }
  }
  if (!hit) ok(rel)
}

// ---------------------------------------------------------------------------
// 6. 可选：打包并列出 tarball 内容（等价于 Release 上挂的那个附件）
// ---------------------------------------------------------------------------
if (args.has('--pack')) {
  console.log('打包')
  const outDir = path.join(ROOT, 'dist')
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  // 候选顺序：环境里的 pnpm → 环境里的 npm → 随 DSH 一起带的 pnpm(.cjs，用当前 node 跑)。
  // Windows 上 .cmd 垫片不能直接 spawnSync（EINVAL），要经 cmd.exe /c；
  // 顺带避开 shell:true 的 DEP0190 弃用警告。
  const win = process.platform === 'win32'
  const localPnpm = [
    path.resolve(path.dirname(process.execPath), '..', 'pnpm', 'bin', 'pnpm.cjs'),
    path.resolve(path.dirname(process.execPath), '..', '..', 'runtime', 'pnpm', 'bin', 'pnpm.cjs'),
  ].find((p) => fs.existsSync(p))
  const candidates = []
  for (const name of ['pnpm', 'npm']) {
    const tail = ['pack', '--pack-destination', outDir]
    if (win) candidates.push([process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', name, ...tail], name])
    else candidates.push([name, tail, name])
  }
  if (localPnpm) candidates.push([process.execPath, [localPnpm, 'pack', '--pack-destination', outDir], 'DSH 自带的 pnpm'])
  let packed = null
  const failures = []
  for (const [cmd, cmdArgs, label] of candidates) {
    try {
      execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
      packed = label
      break
    } catch (error) {
      const stderr = String(error.stderr || error.message).trim().split('\n').filter(Boolean).pop()
      failures.push(label + ': ' + (stderr || String(error.message).split('\n')[0]))
    }
  }
  if (!packed) {
    bad('没有可用的打包命令：\n    ' + failures.join('\n    '))
  } else {
    const file = fs.readdirSync(outDir).find((n) => n.endsWith('.tgz'))
    if (!file) bad('打包没有产出 .tgz')
    else {
      const size = fs.statSync(path.join(outDir, file)).size
      ok(packed + ' pack -> dist/' + file + ' (' + Math.round(size / 1024) + ' KB)')
      const list = execFileSync('tar', ['-tzf', path.join(outDir, file)], { encoding: 'utf8' })
        .split('\n').map((s) => s.trim()).filter(Boolean)
      console.log('    tarball 内含 ' + list.length + ' 项：')
      for (const entry of list) console.log('      ' + entry)
      const wanted = ['package/package.json', 'package/lib/index.js', 'package/assets/wallpaper-client.js', 'package/cordis.patch.yml']
      for (const w of wanted) if (!list.includes(w)) bad('tarball 里缺少 ' + w)
      for (const entry of list) if (/(node_modules|\/dist\/|\.git\/)/.test(entry)) bad('tarball 里混进了 ' + entry)
    }
  }
}

// ---------------------------------------------------------------------------
// 7. 可选：打标签
// ---------------------------------------------------------------------------
if (args.has('--tag')) {
  console.log('打标签')
  const tag = 'v' + pkg.version
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (dirty) bad('工作区不干净，先提交再打标签：\n' + dirty)
  else {
    try {
      execFileSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/' + tag], { cwd: ROOT, stdio: 'pipe' })
      bad('标签 ' + tag + ' 已存在')
    } catch {
      execFileSync('git', ['tag', '-a', tag, '-m', 'dsh-wallpaper-engine ' + tag], { cwd: ROOT, stdio: 'inherit' })
      ok('已打标签 ' + tag + '（推上去：git push origin ' + tag + '）')
    }
  }
}

// ---------------------------------------------------------------------------
console.log('')
if (problems.length) {
  console.log('自检未通过，' + problems.length + ' 个问题：')
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('自检通过：dsh-wallpaper-engine ' + pkg.version)
