// ============================================================================
// dsh-wallpaper-engine —— 把 Wallpaper Engine 的壁纸接进 DSH 界面背景
// ----------------------------------------------------------------------------
// 宿主侧插件做三件事：
//   ① 往页面注入一段内联脚本（桌面端唯一通道：webserver/index-inject 结构化行，
//      该表在宿主启动时一次性收集，所以注入行必须最早注册）；
//   ② 注册 /dsh-we-wallpaper/* 路由：状态、配置、壁纸列表、媒体流（支持 Range）；
//   ③ 探测 Wallpaper Engine 安装目录 + 解析 config.json 里的"当前壁纸"。
//
// 前端脚本在 assets/wallpaper-client.js，按 mtime 热读取（改完硬刷新页面即生效，
// 不需要重启 DSH）。运行时配置在 $DSH_HOME/.dsh-wallpaper.json。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROUTE = '/dsh-we-wallpaper'
const PKG_VERSION = '0.2.0'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, '.dsh-wallpaper.json')
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi']
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.avif']
const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.webp': 'image/webp', '.avif': 'image/avif',
}

const DEFAULT_CONFIG = {
  enabled: true,      // 总开关
  follow: true,       // true=跟随 WE 当前壁纸；false=用 manualId
  manualId: null,     // 手动选择的壁纸 id
  monitor: null,      // 多显示器时指定 "Monitor0" 等
  opacity: 1,         // 壁纸不透明度 0..1
  blur: 0,            // 壁纸模糊 px
  dim: 0.35,          // 壁纸暗化 0..0.95
  fit: 'cover',       // cover=裁切铺满 | fill=模糊填满(不裁切) | contain=完整显示 | stretch=拉伸铺满
  baseAlpha: 0.62,    // DSH 底材（--dsw-alias-bg-base）保留的不透明度，越小壁纸越透
  panelAlpha: 1,      // 面板层（layer-1/2/3）保留的不透明度
  muted: true,        // 壁纸静音
  volume: 0,          // 0..1
  paused: false,      // 暂停播放（仅视频壁纸）
  showButton: true,   // 显示悬浮按钮
  btnPos: null,       // 悬浮按钮位置 {x,y}
  previewFit: true,   // 场景/网页壁纸退回预览图时：自动切「模糊填满」，避免方图被裁 + 被拉糊
  weDir: null,        // Wallpaper Engine 安装目录（自动探测后回写）
  weDirPinned: false, // true=用户在面板里手动指定了 weDir，探测不再覆盖
  // ---- 与「皮肤类」插件（dsh-claude-style 等）的兼容 ----
  // 这类皮肤把内容列/侧栏/窗口外框的背景写成了自己的不透明画布色（有的还带
  // !important），而本插件是靠调淡 DSH 的 --dsw-* 主题变量让壁纸透出来的 ——
  // 于是变量对它无效、壁纸被整块盖住。skinCompat 让前端额外注入一段补丁
  // CSS，把这些画布色按同样的比例调淡。
  skinCompat: true,   // true=注入兼容补丁（皮肤未启用时自动不生效）
  skinAlpha: null,    // 内容区（侧栏/对话列/#root/html/body）保留的不透明度；null=沿用 baseAlpha
  skinFrameAlpha: null, // 窗口外框（frame / 标题栏 / 侧栏列）保留的不透明度；null=沿用 skinAlpha
}

// 桌面端注入行：内联 script，由我们自己建 <script src> 并吞掉 onerror ——
// 路由在就正常加载，路由不在就静默失败，宿主永远不会因为我们起不来。
const BOOT_SCRIPT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(window.__DSH_WALLPAPER_ENGINE__)return;' +
  'var s=document.createElement("script");s.src="' + ROUTE + '/client.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const LOG_RING = []
let lastReport = null   // 前端「诊断」按钮上报的页面实况（排查“壁纸没透出来”用）
function log(line) {
  const s = '[dsh-wallpaper-engine] ' + String(line)
  LOG_RING.push(new Date().toISOString() + ' ' + String(line))
  if (LOG_RING.length > 40) LOG_RING.shift()
  try { console.log(s) } catch (err) {}
}
function msg(err) { return String((err && err.message) || err) }

function readJsonSafe(p) {
  try {
    let s = fs.readFileSync(p, 'utf8')
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
    return JSON.parse(s)
  } catch (err) { return null }
}
function statSafe(p) { try { return fs.statSync(p) } catch (err) { return null } }
function isDir(p) { const st = statSafe(p); return !!st && st.isDirectory() }
function safeReaddir(p) { try { return fs.readdirSync(p) } catch (err) { return [] } }
function mimeOf(p) { return MIME[path.extname(String(p || '')).toLowerCase()] || 'application/octet-stream' }

function loadConfig() {
  const raw = readJsonSafe(CONFIG_FILE)
  return Object.assign({}, DEFAULT_CONFIG, raw && typeof raw === 'object' ? raw : {})
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
    return true
  } catch (err) { log('写配置失败: ' + msg(err)); return false }
}

// ---------------------------------------------------------------------------
// Wallpaper Engine 探测
// ---------------------------------------------------------------------------
let weDetect = { dir: null, ts: 0, busy: null }

function isValidWeDir(d) {
  if (!d || typeof d !== 'string') return false
  try { return fs.statSync(path.join(d, 'config.json')).isFile() } catch (err) { return false }
}

function runCapture(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, timeout: timeoutMs || 8000, maxBuffer: 1 << 20 }, (err, stdout) => {
        // 注意：PowerShell 在某个进程名不存在时会返回退出码 1，但 stdout 依然有效，
        // 所以不能用 err 判断成败，只能看 stdout 内容。
        resolve(String(stdout || ''))
      })
    } catch (err) { resolve('') }
  })
}

async function weFromProcess() {
  const script = 'Get-Process -Name wallpaper64,wallpaper32 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path; exit 0'
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    const out = await runCapture(exe, ['-NoProfile', '-NonInteractive', '-Command', script], 9000)
    const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (line && fs.existsSync(line)) {
      const dir = path.dirname(line)
      if (isValidWeDir(dir)) return dir
    }
  }
  return null
}

async function weDirsFromSteam() {
  const out = await runCapture('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], 6000)
  const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out)
  if (!m) return []
  const steam = m[1].trim().replace(/\//g, '\\')
  const libs = [steam]
  try {
    const text = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8')
    for (const mm of text.matchAll(/"path"\s*"([^"]+)"/g)) libs.push(mm[1].replace(/\\\\/g, '\\'))
  } catch (err) {}
  const found = []
  for (const lib of libs) {
    const cand = path.join(lib, 'steamapps', 'common', 'wallpaper_engine')
    if (isValidWeDir(cand) && found.indexOf(cand) < 0) found.push(cand)
  }
  return found
}

async function detectWeDir(cfg) {
  // 用户手动钉住的目录优先（这台机器上可能存在不止一份 WE 安装）
  if (cfg.weDirPinned && isValidWeDir(cfg.weDir)) return cfg.weDir
  if (weDetect.dir && Date.now() - weDetect.ts < 60000 && isValidWeDir(weDetect.dir)) return weDetect.dir
  if (weDetect.busy) return weDetect.busy
  const job = (async () => {
    const dirs = []
    const push = (d) => { if (isValidWeDir(d) && dirs.indexOf(d) < 0) dirs.push(d) }
    try { push(await weFromProcess()) } catch (err) {}
    push(cfg.weDir)
    try { for (const d of await weDirsFromSteam()) push(d) } catch (err) {}
    let chosen = null
    // 优先挑"config.json 里有已选壁纸"的那份，避免选中另一份空安装
    for (const d of dirs) {
      try { if (readWeState(d).monitorNames.length) { chosen = d; break } } catch (err) {}
    }
    if (!chosen && dirs.length) chosen = dirs[0]
    weDetect = { dir: chosen, ts: Date.now(), busy: null }
    if (chosen) {
      log('探测到 Wallpaper Engine: ' + chosen + '（候选 ' + String(dirs.length) + ' 份）')
      if (cfg.weDir !== chosen) { cfg.weDir = chosen; saveConfig(cfg) }
    } else {
      log('未能探测到 Wallpaper Engine 安装目录')
    }
    return chosen
  })()
  weDetect.busy = job
  return job
}

// ---------------------------------------------------------------------------
// 读取 WE 当前壁纸（config.json → general.wallpaperconfig.selectedwallpapers）
// ---------------------------------------------------------------------------
function readWeState(weDir) {
  const configPath = path.join(weDir, 'config.json')
  const st = statSafe(configPath)
  const obj = readJsonSafe(configPath)
  if (!obj || typeof obj !== 'object') throw new Error('无法解析 ' + configPath)
  let general = obj.general
  if (!general) {
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (v && typeof v === 'object' && v.general && typeof v.general === 'object') { general = v.general; break }
    }
  }
  const wc = general && general.wallpaperconfig
  const sel = wc && wc.selectedwallpapers
  const monitors = {}
  if (sel && typeof sel === 'object') {
    for (const name of Object.keys(sel)) {
      const entry = sel[name]
      if (entry && typeof entry.file === 'string' && entry.file) {
        monitors[name] = { file: path.normalize(entry.file) }
      }
    }
  }
  const names = Object.keys(monitors)
  return {
    configPath: configPath,
    mtimeMs: st ? st.mtimeMs : null,
    monitors: monitors,
    monitorNames: names,
    primaryFile: names.length ? monitors[names[0]].file : null,
  }
}

// ---------------------------------------------------------------------------
// 壁纸库扫描
// ---------------------------------------------------------------------------
function workshopRoot(weDir, currentFile) {
  const cands = []
  if (weDir) cands.push(path.join(path.dirname(path.dirname(weDir)), 'workshop', 'content', '431960'))
  if (currentFile) {
    const m = /^(.*[\\/]431960)[\\/]/i.exec(String(currentFile))
    if (m) cands.push(m[1])
  }
  for (const c of cands) if (isDir(c)) return c
  return null
}

function buildItem(dir, proj, source, sourceLabel, id) {
  const rel = proj && typeof proj.file === 'string' ? proj.file : null
  const file = rel ? path.join(dir, rel) : null
  let preview = proj && typeof proj.preview === 'string' ? path.join(dir, proj.preview) : null
  if (!preview || !statSafe(preview)) {
    preview = null
    for (const cand of ['preview.jpg', 'preview.png', 'preview.gif']) {
      const p = path.join(dir, cand)
      if (statSafe(p)) { preview = p; break }
    }
  }
  const ext = file ? path.extname(file).toLowerCase() : ''
  const declared = proj && typeof proj.type === 'string' ? proj.type.toLowerCase() : ''
  const type = declared || (VIDEO_EXT.indexOf(ext) >= 0 ? 'video' : (IMAGE_EXT.indexOf(ext) >= 0 ? 'image' : 'scene'))
  return {
    id: id,
    title: String((proj && proj.title) || path.basename(dir)),
    type: type,
    source: source,
    sourceLabel: sourceLabel,
    dir: dir,
    file: file && statSafe(file) ? file : null,
    preview: preview,
  }
}

function scanProjects(rootDir, source, sourceLabel, idPrefix) {
  const out = []
  if (!isDir(rootDir)) return out
  for (const name of safeReaddir(rootDir)) {
    const dir = path.join(rootDir, name)
    if (!isDir(dir)) continue
    const proj = readJsonSafe(path.join(dir, 'project.json'))
    if (!proj || typeof proj !== 'object') continue
    if (!proj.file && !proj.preview) continue
    out.push(buildItem(dir, proj, source, sourceLabel, idPrefix + name))
  }
  return out
}

let libCache = { key: '', ts: 0, items: [] }
function scanLibrary(weDir, currentFile) {
  const key = String(weDir) + '|' + String(currentFile)
  if (libCache.key === key && Date.now() - libCache.ts < 5000) return libCache.items
  const items = []
  const wsRoot = workshopRoot(weDir, currentFile)
  if (wsRoot) items.push.apply(items, scanProjects(wsRoot, 'workshop', '创意工坊', 'ws:'))
  if (weDir) {
    items.push.apply(items, scanProjects(path.join(weDir, 'projects', 'myprojects'), 'my', '本地壁纸', 'my:'))
    items.push.apply(items, scanProjects(path.join(weDir, 'projects', 'defaultprojects'), 'default', '内置壁纸', 'def:'))
  }
  libCache = { key: key, ts: Date.now(), items: items }
  return items
}

function synthFromFile(file) {
  const dir = path.dirname(file)
  const proj = readJsonSafe(path.join(dir, 'project.json'))
  const item = buildItem(dir, proj || {}, 'file', '当前壁纸', 'file:' + file)
  if (!item.file) item.file = file
  return item
}

function pickItem(cfg, weState, items) {
  if (cfg.follow) {
    if (!weState || !weState.monitorNames.length) return null
    const name = cfg.monitor && weState.monitors[cfg.monitor] ? cfg.monitor : weState.monitorNames[0]
    const file = weState.monitors[name].file
    const lower = String(file).toLowerCase()
    let hit = null
    for (const it of items) if (it.file && String(it.file).toLowerCase() === lower) { hit = it; break }
    const item = hit ? Object.assign({}, hit) : synthFromFile(file)
    if (!statSafe(item.file)) return null
    item.monitor = name
    item.followed = true
    return item
  }
  for (const it of items) if (it.id === cfg.manualId) { const c = Object.assign({}, it); c.followed = false; return c }
  return null
}

function resolveMedia(item) {
  if (!item) return null
  const ext = path.extname(String(item.file || '')).toLowerCase()
  if (VIDEO_EXT.indexOf(ext) >= 0 && statSafe(item.file)) return { kind: 'video', mediaPath: item.file, mime: mimeOf(item.file), fallback: false }
  if (IMAGE_EXT.indexOf(ext) >= 0 && statSafe(item.file)) return { kind: 'image', mediaPath: item.file, mime: mimeOf(item.file), fallback: false }
  if (item.preview && statSafe(item.preview)) return { kind: 'image', mediaPath: item.preview, mime: mimeOf(item.preview), fallback: true }
  return null
}

function buildEffective(cfg, item, media) {
  if (!cfg.enabled || !item || !media) return null
  const st = statSafe(media.mediaPath)
  const rev = st ? String(Math.round(st.mtimeMs)) + '-' + String(st.size) : '0'
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    kind: media.kind,
    fallback: media.fallback,
    monitored: item.monitor || null,
    followed: !!item.followed,
    mediaUrl: ROUTE + '/media?rev=' + rev,
    previewUrl: item.preview ? ROUTE + '/preview?id=' + encodeURIComponent(item.id) + '&rev=' + rev : null,
    bytes: st ? st.size : 0,
    rev: rev,
    file: media.mediaPath,
  }
}

async function computeState(cfg) {
  const errors = []
  let weDir = null
  try { weDir = await detectWeDir(cfg) } catch (err) { errors.push('探测 Wallpaper Engine 失败: ' + msg(err)) }
  let weState = null
  if (weDir) { try { weState = readWeState(weDir) } catch (err) { errors.push('读取 WE 配置失败: ' + msg(err)) } }
  const currentFile = weState ? weState.primaryFile : null
  const items = scanLibrary(weDir, currentFile)
  const item = pickItem(cfg, weState, items)
  const media = resolveMedia(item)
  const effective = buildEffective(cfg, item, media)
  return {
    weDir: weDir,
    weState: weState,
    currentFile: currentFile,
    items: items,
    item: item,
    media: media,
    effective: effective,
    errors: errors,
  }
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------
function sendJson(res, payload, code) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(code || 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  } catch (err) {}
}
function sendText(res, code, text) {
  try {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  } catch (err) {}
}

// 轻量信任栅栏：只认回环 / 桌面壳 / 无 Host（IPC 桥）的请求
function isTrusted(req) {
  const host = String((req.headers && req.headers.host) || '').toLowerCase()
  if (!host) return true
  const hostname = host.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '')
  if (hostname === 'dsh-app' || hostname === 'app') return true
  const loop = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  if (!loop) return false
  const site = String((req.headers && req.headers['sec-fetch-site']) || '')
  if (site === 'cross-site') return false
  const origin = req.headers && req.headers.origin
  if (origin) {
    const o = String(origin)
    if (o.indexOf('dsh-app://') !== 0) {
      try { if (new URL(o).host.toLowerCase() !== host) return false } catch (err) { return false }
    }
  }
  return true
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > (limit || 262144)) { resolve(''); try { req.destroy() } catch (err) {} return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function serveFile(req, res, filePath, mime, cacheSeconds) {
  const st = statSafe(filePath)
  if (!st || !st.isFile()) { sendText(res, 404, 'file not found'); return }
  const size = st.size
  const headers = {
    'Content-Type': mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=' + String(cacheSeconds == null ? 3600 : cacheSeconds),
  }
  let start = 0
  let end = size - 1
  let code = 200
  const range = req.headers && req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); end = size - 1 }
      else {
        start = Number(m[1] || 0)
        if (m[2] !== '') end = Math.min(size - 1, Number(m[2]))
      }
      if (!(start >= 0 && end >= start && start < size)) {
        try { res.writeHead(416, { 'Content-Range': 'bytes */' + String(size) }); res.end() } catch (err) {}
        return
      }
      code = 206
      headers['Content-Range'] = 'bytes ' + String(start) + '-' + String(end) + '/' + String(size)
    }
  }
  headers['Content-Length'] = String(end - start + 1)
  try { res.writeHead(code, headers) } catch (err) { return }
  if (req.method === 'HEAD') { try { res.end() } catch (err) {} ; return }
  const stream = fs.createReadStream(filePath, { start: start, end: end })
  stream.on('error', () => { try { res.destroy() } catch (err) {} })
  stream.pipe(res)
}

// ---------------------------------------------------------------------------
// 前端脚本（mtime 热读取）
// ---------------------------------------------------------------------------
let clientCache = { mtimeMs: 0, text: '' }
function loadClientJs() {
  const cands = [path.join(PKG_ROOT, 'assets', 'wallpaper-client.js'), path.join(PKG_ROOT, 'wallpaper-client.js')]
  for (const p of cands) {
    const st = statSafe(p)
    if (!st) continue
    if (clientCache.mtimeMs === st.mtimeMs && clientCache.text) return clientCache.text
    try {
      const text = fs.readFileSync(p, 'utf8')
      clientCache = { mtimeMs: st.mtimeMs, text: text }
      return text
    } catch (err) {}
  }
  return clientCache.text || '/* wallpaper-client.js not found */'
}

function sanitizeConfig(patch) {
  const out = {}
  if (!patch || typeof patch !== 'object') return out
  const nums = { opacity: [0, 1], blur: [0, 80], dim: [0, 0.95], volume: [0, 1], baseAlpha: [0, 1], panelAlpha: [0, 1], skinAlpha: [0, 1], skinFrameAlpha: [0, 1] }
  for (const k of Object.keys(nums)) {
    if (typeof patch[k] === 'number' && isFinite(patch[k])) {
      out[k] = Math.min(nums[k][1], Math.max(nums[k][0], patch[k]))
    }
  }
  for (const k of ['enabled', 'follow', 'muted', 'paused', 'showButton', 'skinCompat', 'previewFit']) {
    if (typeof patch[k] === 'boolean') out[k] = patch[k]
  }
  for (const k of ['skinAlpha', 'skinFrameAlpha']) {
    if (patch[k] === null) out[k] = null
  }
  if (typeof patch.fit === 'string' && ['cover', 'contain', 'fill', 'stretch'].indexOf(patch.fit) >= 0) out.fit = patch.fit
  if (typeof patch.manualId === 'string' || patch.manualId === null) out.manualId = patch.manualId
  if (typeof patch.monitor === 'string' || patch.monitor === null) out.monitor = patch.monitor
  if (typeof patch.weDir === 'string' || patch.weDir === null) out.weDir = patch.weDir
  if (typeof patch.weDirPinned === 'boolean') out.weDirPinned = patch.weDirPinned
  if (patch.btnPos === null) out.btnPos = null
  else if (patch.btnPos && typeof patch.btnPos === 'object' && typeof patch.btnPos.x === 'number' && typeof patch.btnPos.y === 'number') {
    out.btnPos = { x: Math.round(patch.btnPos.x), y: Math.round(patch.btnPos.y) }
  }
  return out
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------
export default {
  name: 'dsh-wallpaper-engine',
  apply(root) {
    const disposers = []
    try {
      root.effect(() => () => { for (const d of disposers) { try { if (typeof d === 'function') d() } catch (err) {} } })
    } catch (err) {}

    // ① 注入行：桌面端（Electron）唯一能生效的通道，必须最早注册
    try {
      disposers.push(root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === ROUTE + '/client.js') return
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(ROUTE + '/client.js') >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: BOOT_SCRIPT })
        } catch (err) {}
      }))
    } catch (err) { log('注册注入行失败: ' + msg(err)) }

    // ② 路由：等 webServer 就绪
    try {
      root.inject(['webServer'], (ctx) => {
        const ws = ctx.webServer
        const add = (route) => {
          try { disposers.push(ws.register(route)) } catch (err) { log('注册路由 ' + route.path + ' 失败: ' + msg(err)) }
        }

        add({
          kind: 'exact', path: ROUTE + '/client.js',
          handler: (req, res) => {
            if (!isTrusted(req)) { sendText(res, 403, 'forbidden'); return }
            const body = loadClientJs()
            try {
              res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Length': String(Buffer.byteLength(body)),
              })
              res.end(body)
            } catch (err) {}
          },
        })

        add({
          kind: 'exact', path: ROUTE + '/state',
          handler: async (req, res) => {
            if (!isTrusted(req)) { sendText(res, 403, 'forbidden'); return }
            const cfg = loadConfig()
            const s = await computeState(cfg)
            const item = s.item
            sendJson(res, {
              ok: true,
              version: PKG_VERSION,
              configFile: CONFIG_FILE,
              config: cfg,
              we: {
                dir: s.weDir,
                configPath: s.weState ? s.weState.configPath : null,
                configMtime: s.weState ? s.weState.mtimeMs : null,
                monitorNames: s.weState ? s.weState.monitorNames : [],
                currentFile: s.currentFile,
              },
              current: item ? {
                id: item.id, title: item.title, type: item.type,
                source: item.source, sourceLabel: item.sourceLabel,
                file: item.file, followed: !!item.followed, monitor: item.monitor || null,
              } : null,
              effective: s.effective,
              library: s.items.map((it) => ({
                id: it.id, title: it.title, type: it.type,
                source: it.source, sourceLabel: it.sourceLabel,
                hasPreview: !!it.preview, file: it.file,
              })),
              errors: s.errors,
              lastReport: lastReport,
              log: LOG_RING.slice(-12),
            })
          },
        })

        add({
          kind: 'exact', path: ROUTE + '/config',
          handler: async (req, res) => {
            if (!isTrusted(req)) { sendText(res, 403, 'forbidden'); return }
            if (req.method !== 'POST' && req.method !== 'PUT') { sendText(res, 405, 'use POST'); return }
            const raw = await readBody(req, 262144)
            let patch = null
            try { patch = JSON.parse(raw || '{}') } catch (err) { sendJson(res, { ok: false, error: 'invalid json' }, 400); return }
            const cfg = loadConfig()
            const next = Object.assign(cfg, sanitizeConfig(patch))
            const saved = saveConfig(next)
            if (patch && patch.reloadWe) { weDetect = { dir: null, ts: 0, busy: null }; libCache = { key: '', ts: 0, items: [] } }
            const s = await computeState(next)
            sendJson(res, { ok: saved, config: next, effective: s.effective, current: s.item ? { id: s.item.id, title: s.item.title, type: s.item.type } : null, errors: s.errors })
          },
        })

        // 前端「诊断」按钮把页面实况回传到这里（采到的原色、各层背景、媒体状态）
        add({
          kind: 'exact', path: ROUTE + '/report',
          handler: async (req, res) => {
            if (!isTrusted(req)) { sendText(res, 403, 'forbidden'); return }
            if (req.method !== 'POST' && req.method !== 'PUT') { sendText(res, 405, 'use POST'); return }
            const raw = await readBody(req, 131072)
            if (raw) {
              lastReport = { at: new Date().toISOString(), text: String(raw).slice(0, 12000) }
              log('收到前端诊断报告（' + String(raw.length) + ' 字节）')
            }
            sendJson(res, { ok: true })
          },
        })

        add({
          kind: 'exact', path: ROUTE + '/media',
          handler: async (req, res) => {
            if (!isTrusted(req)) { sendText(res, 403, 'forbidden'); return }
            const cfg = loadConfig()
            const s = await computeState(cfg)
            if (!s.media) { sendText(res, 404, 'no wallpaper media'); return }
            serveFile(req, res, s.media.mediaPath, s.media.mime, 3600)
          },
        })

        add({
          kind: 'exact', path: ROUTE + '/preview',
          handler: async (req, res) => {
            if (!isTrusted(req)) { sendText(res, 403, 'forbidden'); return }
            const url = new URL(req.url || '/', 'http://localhost')
            const id = url.searchParams.get('id') || ''
            const cfg = loadConfig()
            const s = await computeState(cfg)
            let hit = null
            for (const it of s.items) if (it.id === id) { hit = it; break }
            if (!hit && s.item && s.item.id === id) hit = s.item
            if (!hit || !hit.preview) { sendText(res, 404, 'no preview'); return }
            serveFile(req, res, hit.preview, mimeOf(hit.preview), 3600)
          },
        })

        // 网页版（浏览器经 dsh-host-webserver 拿 index.html）走 tapIndex：
        // 桌面端 Electron 的 index.html 直接从安装包 dist 读盘，tapIndex 永远过不去，
        // 那边只能靠上面的 webserver/index-inject 结构化行。两条并存、各自去重。
        try {
          disposers.push(ws.tapIndex((html) => {
            if (typeof html !== 'string') return html
            if (html.indexOf(ROUTE + '/client.js') !== -1) return html
            const tag = '<script defer src="' + ROUTE + '/client.js"></script>'
            if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
            return html + tag
          }))
        } catch (err) { log('注册 tapIndex 失败: ' + msg(err)) }

        log('已注册 ' + ROUTE + '/* 路由 (v' + PKG_VERSION + ')')
      })
    } catch (err) { log('等待 webServer 失败: ' + msg(err)) }
  },
}

export const internals = {
  ROUTE: ROUTE,
  CONFIG_FILE: CONFIG_FILE,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  BOOT_SCRIPT: BOOT_SCRIPT,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  readWeState: readWeState,
  scanLibrary: scanLibrary,
  pickItem: pickItem,
  resolveMedia: resolveMedia,
  buildEffective: buildEffective,
  computeState: computeState,
  detectWeDir: detectWeDir,
  sanitizeConfig: sanitizeConfig,
  isTrusted: isTrusted,
  loadClientJs: loadClientJs,
}
