// ============================================================================
// dsh-wallpaper-engine —— 前端（注入到 DSH 页面里运行）
// ----------------------------------------------------------------------------
// 做三件事：
//   ① 在页面最底层铺一个 fixed 图层，播放 Wallpaper Engine 的壁纸（视频/图片）；
//   ② 把 DSH 自己的底材（--dsw-alias-bg-base）与面板层调成半透明，让壁纸透出来；
//   ③ 一个可拖动的小按钮 + 设置面板（跟随 WE / 手动挑选 / 透明度 / 模糊 / 暗化 …）。
// 所有配置都由宿主持久化在 $DSH_HOME/.dsh-wallpaper.json。
// ============================================================================
(function () {
  'use strict'
  if (window.__DSH_WALLPAPER_ENGINE__) return
  window.__DSH_WALLPAPER_ENGINE__ = true

  var BASE = '/dsh-we-wallpaper'
  var POLL_MS = 4000

  var server = null          // /state 返回的整包
  var cfg = null             // 配置副本
  var effUrl = ''            // 当前媒体 URL（避免重复设置 src 导致重播）
  var styleEl = null
  var compatEl = null        // 皮肤兼容补丁样式表（见 applyCompatCss）
  var compatSig = ''         // 上次写入的补丁 CSS（签名比对，避免无谓重写）
  var compatAt = 0
  var layerEl = null
  var mediaEl = null
  var backdropEl = null      // 铺满屏幕的模糊背景（同一张图，见 mediaFor）
  var backdropUrl = ''
  var mediaKind = ''
  var mediaInfo = { url: '', kind: '', w: 0, h: 0, preview: false }  // 当前媒体的原始分辨率与来源
  var dimEl = null
  var btnEl = null
  var panelEl = null
  var orig = { base: '', sidebar: '', l1: '', l2: '', l3: '' }
  var syncing = false
  var syncers = []
  var saveTimer = null
  var pendingPatch = {}

  function log() {
    try { console.log.apply(console, ['[dsh-wallpaper]'].concat(Array.prototype.slice.call(arguments))) } catch (e) {}
  }
  function ce(tag) { return document.createElement(tag) }

  // -------------------------------------------------------------------------
  // 图层
  // -------------------------------------------------------------------------
  function ensureLayer() {
    if (layerEl && layerEl.isConnected) return
    layerEl = ce('div')
    layerEl.id = 'dsh-we-layer'
    layerEl.setAttribute('aria-hidden', 'true')
    dimEl = ce('div')
    dimEl.id = 'dsh-we-dim'
    layerEl.appendChild(dimEl)
    document.body.appendChild(layerEl)
  }

  // 壁纸元素：一个前台（原图，按 fillMode 定对象框）+ 一个背景（同一张图放大模糊填满屏幕）。
  // 「背景」是给正方形缩略图准备的：它只负责铺满屏幕、顺便把主图的平均色带到边缘，
  // 主图因此可以用 contain 完整显示而不被裁掉。
  function makeMediaEl(kind, id) {
    var el
    if (kind === 'video') {
      el = ce('video')
      el.autoplay = true
      el.loop = true
      el.muted = true
      el.playsInline = true
      el.setAttribute('playsinline', '')
      el.setAttribute('disablepictureinpicture', '')
    } else {
      el = ce('img')
      el.alt = ''
      el.draggable = false
    }
    el.id = id
    return el
  }

  function mediaFor(kind) {
    if (mediaEl && mediaKind === kind && mediaEl.isConnected) return mediaEl
    if (mediaEl && mediaEl.parentNode) mediaEl.parentNode.removeChild(mediaEl)
    if (backdropEl && backdropEl.parentNode) backdropEl.parentNode.removeChild(backdropEl)
    mediaEl = makeMediaEl(kind, 'dsh-we-media')
    backdropEl = makeMediaEl(kind, 'dsh-we-backdrop')
    backdropEl.setAttribute('aria-hidden', 'true')
    mediaKind = kind
    layerEl.insertBefore(backdropEl, dimEl)
    layerEl.insertBefore(mediaEl, dimEl)
    effUrl = ''
    backdropUrl = ''
    return mediaEl
  }

  // -------------------------------------------------------------------------
  // 透明化 CSS
  // -------------------------------------------------------------------------
  function captureOriginals() {
    try {
      var cs = getComputedStyle(document.body)
      orig.base = (cs.getPropertyValue('--dsw-alias-bg-base') || '').trim()
      // Windows 桌面端的外框不是用 bg-base 画的：
      // [data-windows-titlebar] .BynINW_frame{background:var(--dsw-specific-sidebar-fill)}
      // 只把内容列变透明，壁纸会被这层外框整个盖住 —— 必须一起处理。
      orig.sidebar = (cs.getPropertyValue('--dsw-specific-sidebar-fill') || '').trim()
      orig.l1 = (cs.getPropertyValue('--dsw-alias-bg-layer-1') || '').trim()
      orig.l2 = (cs.getPropertyValue('--dsw-alias-bg-layer-2') || '').trim()
      orig.l3 = (cs.getPropertyValue('--dsw-alias-bg-layer-3') || '').trim()
    } catch (e) {}
    if (!orig.base) orig.base = 'rgb(16 17 20)'
    if (!orig.sidebar) orig.sidebar = orig.base
    if (!orig.l1) orig.l1 = orig.base
    if (!orig.l2) orig.l2 = orig.base
    if (!orig.l3) orig.l3 = orig.base
  }

  function refreshOriginals() {
    if (!styleEl) return
    var prev = { base: orig.base, sidebar: orig.sidebar, l1: orig.l1, l2: orig.l2, l3: orig.l3 }
    var keep = styleEl.textContent
    styleEl.textContent = ''
    var b = document.body
    b.style.removeProperty('--dsh-we-orig-base')
    b.style.removeProperty('--dsh-we-orig-sidebar')
    b.style.removeProperty('--dsh-we-orig-l1')
    b.style.removeProperty('--dsh-we-orig-l2')
    b.style.removeProperty('--dsh-we-orig-l3')
    void b.offsetHeight
    captureOriginals()
    styleEl.textContent = keep
    var same = prev.base === orig.base && prev.sidebar === orig.sidebar && prev.l1 === orig.l1 && prev.l2 === orig.l2 && prev.l3 === orig.l3
    applyCss()
    if (!same) log('主题色已重新取样')
  }

  function pct(v) { return String(Math.round(v * 1000) / 10) + '%' }
  function px(v) { return String(Math.round(v)) + 'px' }

  function buildCss() {
    var css = ''
    css += '#dsh-we-layer{position:fixed;left:0;top:0;right:0;bottom:0;z-index:0;pointer-events:none;overflow:hidden;background:transparent}'
    // 前台媒体：object-fit / object-position 由 applyMedia 按「填充方式」写死
    css += '#dsh-we-media{position:absolute;left:0;top:0;width:100%;height:100%;display:block;object-position:center;transition:opacity .4s ease}'
    // 背景媒体：同一张图，铺满 + 放大 + 模糊。只在「模糊填满」模式显示，负责让整屏没有空带。
    css += '#dsh-we-backdrop{position:absolute;left:0;top:0;width:100%;height:100%;display:block;object-fit:cover;object-position:center;transform:scale(1.22);filter:blur(46px) saturate(1.15) brightness(.86)}'
    css += '#dsh-we-dim{position:absolute;left:0;top:0;right:0;bottom:0;background:#000;opacity:0;pointer-events:none}'
    css += '#dsh-we-btn{position:fixed;z-index:2147483000;box-sizing:border-box;width:36px;height:36px;padding:0;border-radius:12px;border:1px solid rgb(255 255 255 / 16%);background:rgb(30 31 38 / 82%);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:var(--dsw-alias-label-primary,#e8eaed);font-size:17px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:grab;box-shadow:0 6px 20px rgb(0 0 0 / 38%);user-select:none;touch-action:none;transition:filter .15s ease,transform .15s ease}'
    css += '#dsh-we-btn:hover{filter:brightness(1.18)}'
    css += '#dsh-we-btn[data-active="0"]{opacity:.55}'
    css += '#dsh-we-panel{position:fixed;z-index:2147483001;box-sizing:border-box;width:330px;max-height:min(76vh,700px);overflow-y:auto;padding:14px 14px 12px;border-radius:16px;border:1px solid rgb(255 255 255 / 14%);background:rgb(28 29 35 / 94%);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);color:var(--dsw-alias-label-primary,#e8eaed);box-shadow:0 18px 48px rgb(0 0 0 / 52%);font:13px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}'
    css += '#dsh-we-panel h4{margin:0 0 2px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}'
    css += '#dsh-we-panel .we-sub{color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11.5px;word-break:break-all}'
    css += '#dsh-we-panel .we-sec{margin:10px 0 0;padding-top:10px;border-top:1px solid rgb(255 255 255 / 10%)}'
    css += '#dsh-we-panel .we-row{display:flex;align-items:center;gap:8px;margin:7px 0;justify-content:space-between}'
    css += '#dsh-we-panel .we-row>label{flex:0 0 auto;color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:12px}'
    css += '#dsh-we-panel .we-row>.we-ctl{display:flex;align-items:center;gap:6px;flex:1 1 auto;justify-content:flex-end;min-width:0}'
    css += '#dsh-we-panel input[type=range]{-webkit-appearance:none;appearance:none;height:18px;background:transparent;width:118px;min-width:60px;cursor:pointer}'
    css += '#dsh-we-panel input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:3px;background:rgb(255 255 255 / 22%)}'
    css += '#dsh-we-panel input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;margin-top:-4.5px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4d6bfe)}'
    css += '#dsh-we-panel select{max-width:190px;min-width:0;flex:1 1 auto;background:rgb(255 255 255 / 8%);color:inherit;border:1px solid rgb(255 255 255 / 14%);border-radius:8px;padding:4px 6px;font:inherit;font-size:12px}'
    css += '#dsh-we-panel button{background:rgb(255 255 255 / 9%);color:inherit;border:1px solid rgb(255 255 255 / 14%);border-radius:8px;padding:4px 9px;font:inherit;font-size:12px;cursor:pointer}'
    css += '#dsh-we-panel button:hover{background:rgb(255 255 255 / 16%)}'
    css += '#dsh-we-panel .we-val{flex:0 0 46px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11.5px}'
    css += '#dsh-we-panel .we-close{margin-left:auto;padding:0 7px;line-height:20px}'
    css += '#dsh-we-panel .we-badge{display:inline-block;padding:1px 6px;border-radius:6px;background:rgb(255 255 255 / 12%);font-size:11px;margin-left:6px}'
    css += '#dsh-we-panel .we-warn{color:#f0b45a;font-size:11.5px;margin-top:4px}'
    css += '#dsh-we-panel .we-err{color:#ff8b7a;font-size:11px;margin-top:4px;white-space:pre-wrap;word-break:break-all}'
    css += '#dsh-we-panel input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}'
    if (!cfg || !cfg.enabled) return css
    var b = cfg.enabled ? cfg.baseAlpha : 1
    var p = cfg.enabled ? cfg.panelAlpha : 1
    if (b < 1 || p < 1) {
      css += 'html,body{background:transparent !important}'
      css += '#root{background:transparent !important;position:relative;z-index:1}'
    }
    if (b < 1) {
      css += 'body{--dsw-alias-bg-base:color-mix(in srgb, var(--dsh-we-orig-base) ' + pct(b) + ', transparent) !important;'
      css += '--dsw-specific-sidebar-fill:color-mix(in srgb, var(--dsh-we-orig-sidebar) ' + pct(b) + ', transparent) !important}'
    }
    if (p < 1) {
      css += 'body{--dsw-alias-bg-layer-1:color-mix(in srgb, var(--dsh-we-orig-l1) ' + pct(p) + ', transparent) !important;'
      css += '--dsw-alias-bg-layer-2:color-mix(in srgb, var(--dsh-we-orig-l2) ' + pct(p) + ', transparent) !important;'
      css += '--dsw-alias-bg-layer-3:color-mix(in srgb, var(--dsh-we-orig-l3) ' + pct(p) + ', transparent) !important}'
    }
    return css
  }

  function applyCss() {
    if (!styleEl || !document.body) return
    if (!orig.base) captureOriginals()
    var b = document.body.style
    b.setProperty('--dsh-we-orig-base', orig.base)
    b.setProperty('--dsh-we-orig-sidebar', orig.sidebar)
    b.setProperty('--dsh-we-orig-l1', orig.l1)
    b.setProperty('--dsh-we-orig-l2', orig.l2)
    b.setProperty('--dsh-we-orig-l3', orig.l3)
    var next = buildCss()
    if (styleEl.textContent !== next) styleEl.textContent = next
    // 兼容补丁排在最后：它要读 orig.* 和 cfg，且必须在 --dsw-* 覆盖之后落笔。
    try { applyCompatCss() } catch (e) {}
  }

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return
    styleEl = ce('style')
    styleEl.id = 'dsh-we-style'
    document.head.appendChild(styleEl)
    captureOriginals()
  }

  // -------------------------------------------------------------------------
  // 皮肤兼容层（dsh-claude-style 等）
  // -------------------------------------------------------------------------
  // 皮肤把内容列 / 侧栏 / 窗口外框画成自己的不透明画布色（很多还带 !important），
  // 本插件调淡的 --dsw-* 变量对它无效，壁纸就被整块盖住。
  // 这里额外注入一段补丁 CSS：只把这些画布色按 cfg.skinAlpha / skinFrameAlpha
  // 调淡，不碰皮肤的任何排版与配色。
  //
  // 三个细节决定它能不能稳定生效：
  //   ① 特异性：皮肤的规则是 (0,3,1)~(0,5,1) 且带 !important，补丁用属性选择器
  //      加倍到 (0,7,1)~(0,9,1)，同一份声明加不加 !important 都赢；
  //   ② 顺序：皮肤的样式表是后 append 到 <head> 的，而浏览器对「同为 !important」
  //      只有特异性相同才比顺序；补丁靠 ① 取胜，同时每次应用都把自己移到 <head>
  //      末尾，双保险；
  //   ③ 变量传播：皮肤的画布色是继承变量，变量在 body 上被覆盖成半透明后，
  //      侧栏规则里的 !important 会把「带 !important 的父级值」重新捡回去，
  //      所以补丁必须把侧栏元素自己的 background 也一起接管。
  var SKIN_ATTR = 'data-dsh-claude-style'

  function skinDark() { return document.body.hasAttribute('data-ds-dark-theme') }

  // 折半取整：保证「补丁生成的规则」和「按同比例算出的采样原色」用同一个数值。
  function heldPct(a) { return Math.round(Math.max(0, Math.min(1, a)) * 1000) / 10 }

  function alphaVar(name, value, important) {
    return 'body[data-dsh-we-compat]{' + name + ':' + value + (important === false ? '' : ' !important') + '}'
  }

  function buildCompatCss() {
    if (!cfg || !cfg.skinCompat || !cfg.enabled) return ''
    if (!document.body || !document.body.hasAttribute(SKIN_ATTR)) return ''
    var base = cfg.skinAlpha == null ? cfg.baseAlpha : cfg.skinAlpha
    var frame = cfg.skinFrameAlpha == null ? base : cfg.skinFrameAlpha
    if (base >= 1 && frame >= 1) return ''
    var has = function (n) { return document.body.hasAttribute(n) }
    var a = has('data-dsh-claude-brand="anthropic"') ? 'anthropic'
      : has('data-dsh-claude-brand="claude"') ? 'claude'
        : has('data-dsh-claude-brand="deepseek"') ? 'deepseek' : ''
    var dark = skinDark()
    var basePct = heldPct(base)
    var framePct = heldPct(frame)
    var css = ''
    css += '/* 底材：html/body/#root（配色跟着皮肤的品牌 + 明暗走） */'
    css += alphaVar('--dsh-we-canvas', 'color-mix(in srgb, var(--dsh-we-orig-base) ' + pct(base) + ', transparent)')
    css += alphaVar('--dsh-we-canvas-strong', 'color-mix(in srgb, var(--dsh-we-orig-base) ' + pct(Math.min(1, base + 0.12)) + ', transparent)')
    css += 'body[data-dsh-we-compat] .dsh-we-skin-alpha[data-dsh-we-compat]{transition:background-color .18s ease}'
    // #root / 对话列：皮肤在明色下给 #root 单独写的规则带 !important，这里一起接管
    css += 'body[data-dsh-we-compat][data-dsh-we-compat][data-dsh-we-compat]:not([data-ds-dark-theme]) #root,'
    css += 'body[data-dsh-we-compat][data-dsh-we-compat][data-dsh-we-compat][data-ds-dark-theme] #root,'
    css += 'body[data-dsh-we-compat][data-dsh-we-compat][data-dsh-we-compat] #root,'
    css += 'body[data-dsh-we-compat][data-dsh-we-compat][data-dsh-we-compat] :is([data-pane="conversation"],[class*="centerCol"])'
    css += '{background:var(--dsh-we-canvas) !important;background-color:var(--dsh-we-canvas) !important}'
    // 侧栏：皮肤把画布色写进 --dsw-specific-sidebar-fill（值本身带 !important），
    // 侧栏元素的 background 也有 !important —— 所以元素本身必须一起接管
    css += 'body[data-dsh-we-compat][data-dsh-we-compat][data-dsh-we-compat][data-dsh-we-compat] :is([data-pane="sidebar"],[class*="sidebarCol"],.dshDesktopSidebarSurface)'
    css += '{--dsw-specific-sidebar-fill:var(--dsh-we-canvas) !important;background:var(--dsh-we-canvas) !important}'
    // 窗口外框：Windows 标题栏 / 侧栏列 / 三栏 frame 用的是 --dsw-specific-sidebar-fill
    if (frame < 1) {
      css += alphaVar('--dsw-specific-sidebar-fill', 'color-mix(in srgb, var(--dsh-we-orig-sidebar) ' + pct(frame) + ', transparent)')
      css += 'body[data-dsh-we-compat][data-dsh-we-compat][data-dsh-we-compat] [class*="_frame"]'
      css += '{background:var(--dsw-specific-sidebar-fill) !important}'
      css += 'body[data-dsh-we-compat][data-dsh-we-compat][data-dsh-we-compat] [class*="_frame"]::before'
      css += '{background:var(--dsw-specific-sidebar-fill) !important}'
      css += 'body[data-dsh-we-compat][data-dsh-we-compat][data-dsh-we-compat] :is([data-pane="sidebar"],[class*="sidebarCol"],.dshDesktopSidebarSurface)'
      css += '{background:var(--dsw-specific-sidebar-fill) !important}'
    }
    // 皮肤自己的画布 token：让它内部仍用 var(--dsh-claude-canvas) 画的地方
    // （搜索面板、用量卡片等）一并透出壁纸。!important 是必须的 ——
    // 皮肤自己就是在 body 上以 !important 声明这两个 token 的。
    css += alphaVar('--dsh-claude-canvas', 'var(--dsh-we-canvas)')
    css += alphaVar('--dsh-claude-sidebar-canvas', 'var(--dsh-we-canvas-strong)')
    // html / body：皮肤在明色下对 html 直接写死了画布色（:has 选择器、无
    // !important），明暗两套都要接管；品牌属性照搬，明色的三套画布色才不会串。
    var brandAttr = a ? '[data-dsh-we-brand="' + a + '"]' : ''
    css += 'html[data-dsh-we-compat]' + brandAttr + '[data-dsh-we-compat][data-dsh-we-compat]' +
      '{background-color:var(--dsh-we-canvas) !important;background:var(--dsh-we-canvas) !important}'
    css += 'body[data-dsh-we-compat]' + brandAttr + '{background-color:var(--dsh-we-canvas) !important;background:var(--dsh-we-canvas) !important}'
    return css + '/* base=' + String(basePct) + '% frame=' + String(framePct) + '% dark=' + String(dark) + ' brand=' + (a || '-') + ' */'
  }

  // html/body 上的两个标记属性：data-dsh-we-compat 用来给补丁限域，
  // data-dsh-we-brand 把皮肤的品牌映射过去（明色下不同品牌画布色不同），
  // class 只管过渡。
  function syncCompatAttrs(on) {
    try {
      var b = document.body
      var owner = document.documentElement || b
      var els = [document.documentElement, b]
      var brand = ''
      if (on && b) {
        if (b.hasAttribute('data-dsh-claude-brand="anthropic"')) brand = 'anthropic'
        else if (b.hasAttribute('data-dsh-claude-brand="claude"')) brand = 'claude'
        else if (b.hasAttribute('data-dsh-claude-brand="deepseek"')) brand = 'deepseek'
      }
      for (var i = 0; i < els.length; i++) {
        var e = els[i]
        if (!e) continue
        if (on) {
          if (!e.hasAttribute('data-dsh-we-compat')) e.setAttribute('data-dsh-we-compat', '')
          if (brand) { if (e.getAttribute('data-dsh-we-brand') !== brand) e.setAttribute('data-dsh-we-brand', brand) }
          else if (e.hasAttribute('data-dsh-we-brand')) e.removeAttribute('data-dsh-we-brand')
          if (e.classList && !e.classList.contains('dsh-we-skin-alpha')) e.classList.add('dsh-we-skin-alpha')
        } else {
          if (e.hasAttribute('data-dsh-we-compat')) e.removeAttribute('data-dsh-we-compat')
          if (e.hasAttribute('data-dsh-we-brand')) e.removeAttribute('data-dsh-we-brand')
          if (e.classList) e.classList.remove('dsh-we-skin-alpha')
        }
      }
      // 诊断标记只在补丁生效时挂着：皮肤被关掉/壁纸被关掉后，页面上不留痕迹。
      if (owner) {
        if (on) {
          owner.setAttribute('data-dsh-we-compat-at', String(compatAt))
          if (!owner.hasAttribute('data-dsh-we-compat-on')) owner.setAttribute('data-dsh-we-compat-on', '')
        } else {
          if (owner.hasAttribute('data-dsh-we-compat-at')) owner.removeAttribute('data-dsh-we-compat-at')
          if (owner.hasAttribute('data-dsh-we-compat-on')) owner.removeAttribute('data-dsh-we-compat-on')
        }
      }
    } catch (e) {}
  }

  function applyCompatCss() {
    // 先认一下页面上的皮肤状态，再决定补丁的开关与内容。
    var css = buildCompatCss()
    var on = !!css
    compatAt = Date.now()
    syncCompatAttrs(on)
    if (!on) {
      if (compatEl) { try { compatEl.remove() } catch (e) {} compatEl = null }
      compatSig = ''
      return
    }
    if (!compatEl || !compatEl.isConnected) {
      if (compatEl) { try { compatEl.remove() } catch (e) {} }
      compatEl = ce('style')
      compatEl.id = 'dsh-we-skin-compat'
      document.head.appendChild(compatEl)
      compatSig = ''
    } else if (document.head.lastElementChild !== compatEl) {
      // 皮肤后 append 的样式表会排在补丁后面：把补丁挪到末尾再稳一层。
      try { document.head.appendChild(compatEl) } catch (e) {}
    }
    if (compatSig !== css) { compatEl.textContent = css; compatSig = css }
  }

  function refreshCompatSoon(ms) {
    if (window.__DSH_WE_COMPAT_T__) clearTimeout(window.__DSH_WE_COMPAT_T__)
    window.__DSH_WE_COMPAT_T__ = setTimeout(function () {
      window.__DSH_WE_COMPAT_T__ = null
      try { applyCompatCss() } catch (e) {}
    }, ms == null ? 80 : ms)
  }

  function watchHead() {
    if (window.__DSH_WE_COMPAT_MO__) return
    try {
      var mo = new MutationObserver(function () { refreshCompatSoon() })
      // 只盯 <head> 的「直接子节点增删」：皮肤的样式表就是这么进来的。
      // 不能盯 subtree/attributes —— 补丁自己的写入会被观察到，形成自激循环。
      mo.observe(document.head, { childList: true })
      window.__DSH_WE_COMPAT_MO__ = mo
    } catch (e) {}
  }

  // 面板状态行 + 诊断用的单行摘要。
  function skinDiag() {
    var skinOn = !!(document.body && document.body.hasAttribute(SKIN_ATTR))
    var parts = []
    parts.push('detect=' + (skinOn ? 'on' : 'off'))
    parts.push('cfg=' + (cfg ? String(!!cfg.skinCompat) : '-'))
    if (cfg && cfg.enabled && cfg.skinCompat && skinOn) {
      var base = cfg.skinAlpha == null ? cfg.baseAlpha : cfg.skinAlpha
      var frame = cfg.skinFrameAlpha == null ? base : cfg.skinFrameAlpha
      parts.push('active=on')
      parts.push('base=' + pct(base))
      parts.push('frame=' + pct(frame))
      parts.push('sheet=' + (compatSig ? String(compatSig.length) + 'B' : '无'))
      parts.push('lastWrite=' + (compatAt ? String(Math.round((Date.now() - compatAt) / 1000)) + 's前' : '-'))
    } else {
      parts.push('active=off')
    }
    return parts.join(' ')
  }

  // -------------------------------------------------------------------------
  // 媒体应用
  // -------------------------------------------------------------------------
  function applyMedia() {
    ensureLayer()
    var eff = server && server.effective
    if (!cfg || !cfg.enabled || !eff) {
      if (layerEl) layerEl.style.display = 'none'
      return
    }
    layerEl.style.display = ''
    var el = mediaFor(eff.kind)
    var url = eff.mediaUrl
    if (url !== effUrl) {
      effUrl = url
      setMediaSrc(el, url, eff.kind)
    }
    // 背景层用同一张图；它只为「铺满」服务，视频用同一路 src 会再解一份，
    // 太贵，所以只给图片配背景层。
    var wantBackdrop = effectiveFit() === 'fill' && eff.kind === 'image'
    if (wantBackdrop && backdropEl) {
      if (backdropUrl !== url) { backdropUrl = url; setMediaSrc(backdropEl, url, eff.kind) }
      backdropEl.style.display = ''
      backdropEl.style.opacity = String(cfg.opacity)
    } else if (backdropEl) {
      backdropEl.style.display = 'none'
    }
    el.style.opacity = String(cfg.opacity)
    el.style.filter = cfg.blur > 0 ? 'blur(' + px(cfg.blur) + ')' : 'none'
    el.style.transform = cfg.blur > 0 ? 'scale(' + String(1 + cfg.blur / 120) + ')' : 'none'
    // 「模糊填满」：前台只负责把整张图完整放进来（contain），裁切与铺满交给背景层 ——
    // 正方形缩略图因此既不会被裁掉两侧，也不会被拉成 16:9。
    var fit = effectiveFit()
    el.style.objectFit = fit === 'fill' ? 'contain' : (fit === 'stretch' ? 'fill' : fit)
    if (dimEl) dimEl.style.opacity = String(cfg.dim)
    if (eff.kind === 'video') {
      el.muted = !!cfg.muted
      try { el.volume = cfg.muted ? 0 : Math.max(0, Math.min(1, cfg.volume)) } catch (e) {}
      if (cfg.paused || document.hidden) { try { el.pause() } catch (e) {} }
      else { try { var p = el.play(); if (p && p.catch) p.catch(function () {}) } catch (e) {} }
    }
  }

  // 直接把媒体地址交给 <video>/<img>：桌面端 dsh-app://app/<path> 会被
  // forwardWebRequest 带 cookie 转发给本地 HTTP 服务（Range 头也保留），所以正常能流式播放。
  // 万一某天转发链路变了，这里 3.5 秒内没拿到数据就退回 fetch→blob（fetch 走的是页面自己的桥，更稳）。
  var mediaFallback = { blobUrl: '', timer: null, used: false }
  function blobFallback(el, url) {
    if (mediaFallback.used) return
    mediaFallback.used = true
    if (mediaFallback.timer) { clearTimeout(mediaFallback.timer); mediaFallback.timer = null }
    log('直接播放未就绪，改用 fetch→blob')
    fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.blob() })
      .then(function (b) {
        if (mediaFallback.blobUrl) { try { URL.revokeObjectURL(mediaFallback.blobUrl) } catch (e) {} }
        mediaFallback.blobUrl = URL.createObjectURL(b)
        el.src = mediaFallback.blobUrl
        if (el.tagName === 'VIDEO') { try { el.load(); var pr = el.play(); if (pr && pr.catch) pr.catch(function () {}) } catch (e) {} }
      })
      .catch(function (e) { log('blob 回退失败', e) })
  }
  // 记下当前媒体的原始分辨率与来源（原图 / 预览图 / 回退预览），面板据此给出画质提示。
  function measureMedia() {
    var el = mediaEl
    var eff = server && server.effective
    if (!el || !eff) return
    var w = 0
    var h = 0
    if (eff.kind === 'video') { w = el.videoWidth || 0; h = el.videoHeight || 0 }
    else { w = el.naturalWidth || 0; h = el.naturalHeight || 0 }
    if (!w || !h) return
    var changed = mediaInfo.url !== eff.mediaUrl || mediaInfo.w !== w || mediaInfo.h !== h
    mediaInfo = { url: eff.mediaUrl, kind: eff.kind, w: w, h: h, preview: !!eff.fallback }
    if (changed) { try { if (panelEl) renderStatus() } catch (e) {} }
  }

  function setMediaSrc(el, url, kind) {
    if (mediaFallback.timer) { clearTimeout(mediaFallback.timer); mediaFallback.timer = null }
    if (mediaFallback.blobUrl) { try { URL.revokeObjectURL(mediaFallback.blobUrl) } catch (e) {} mediaFallback.blobUrl = '' }
    mediaFallback.used = false
    el.src = url
    if (kind === 'video') { try { el.load(); var pr = el.play(); if (pr && pr.catch) pr.catch(function () {}) } catch (e) {} }
    // 拿到真实尺寸就记下来：面板要拿它判断「这张图是不是被放大到失真」。
    if (mediaEl === el) {
      if (kind === 'video') el.addEventListener('loadedmetadata', measureMedia, { once: true })
      else {
        el.addEventListener('load', measureMedia, { once: true })
        if (el.complete) measureMedia()
      }
    }
    el.addEventListener('loadeddata', function () {
      if (mediaFallback.timer) { clearTimeout(mediaFallback.timer); mediaFallback.timer = null }
    }, { once: true })
    el.addEventListener('error', function () { blobFallback(el, url) }, { once: true })
    mediaFallback.timer = setTimeout(function () {
      if (el.readyState >= 2) return
      blobFallback(el, url)
    }, 3500)
  }

  // -------------------------------------------------------------------------
  // 与宿主通信
  // -------------------------------------------------------------------------
  function fetchState() {
    return fetch(BASE + '/state', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) return
        var first = !cfg
        server = j
        var patch = j.config || {}
        // 老宿主（非本次更新的版本）缺字段时补上默认值：皮肤兼容缺了会把补丁整条关掉，
        // 预览图适配缺了则会让场景壁纸继续被裁 —— 两者都得有个安全默认。
        if (patch.skinCompat === undefined) patch.skinCompat = true
        if (patch.skinAlpha === undefined) patch.skinAlpha = null
        if (patch.skinFrameAlpha === undefined) patch.skinFrameAlpha = null
        if (patch.previewFit === undefined) patch.previewFit = true
        cfg = patch
        if (first) { ensureStyle(); captureOriginals() }
        applyCss()
        applyMedia()
        updateUI()
        // 皮肤可能在我们之后才把自己挂上（或换了样式表）：稍后再合一次。
        refreshCompatSoon(150)
      })
      .catch(function () {})
  }

  function pushConfig(patch, immediate) {
    for (var k in patch) pendingPatch[k] = patch[k]
    if (immediate) { flushConfig(); return }
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushConfig, 260)
  }

  function flushConfig() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    var patch = pendingPatch
    pendingPatch = {}
    fetch(BASE + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j) return
        if (j.config) cfg = j.config
        if (cfg && cfg.skinCompat === undefined) cfg.skinCompat = true
        if (server) { server.effective = j.effective; server.current = j.current || server.current }
        applyCss()
        applyMedia()
        updateUI()
      })
      .catch(function () {})
  }

  // -------------------------------------------------------------------------
  // 面板 UI
  // -------------------------------------------------------------------------
  function el(tag, css, text) {
    var e = ce(tag)
    if (css) e.style.cssText = css
    if (text != null) e.textContent = text
    return e
  }
  function row(labelText) {
    var r = el('div', 'display:flex;align-items:center;gap:8px;margin:7px 0;justify-content:space-between')
    var l = el('label', 'flex:0 0 auto;color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:12px', labelText)
    var c = el('div', 'display:flex;align-items:center;gap:6px;flex:1 1 auto;justify-content:flex-end;min-width:0')
    r.appendChild(l)
    r.appendChild(c)
    return { root: r, ctl: c }
  }
  function makeSlider(min, max, step, get, set, fmt) {
    var wrap = el('div', 'display:flex;align-items:center;gap:6px;flex:1 1 auto;justify-content:flex-end')
    var inp = ce('input')
    inp.type = 'range'
    inp.min = String(min); inp.max = String(max); inp.step = String(step)
    var val = el('span', 'flex:0 0 46px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11.5px')
    inp.addEventListener('input', function () { val.textContent = fmt(Number(inp.value)); set(Number(inp.value)) })
    wrap.appendChild(inp); wrap.appendChild(val)
    syncers.push(function () { var v = get(); inp.value = String(v); val.textContent = fmt(v) })
    return wrap
  }
  function makeCheck(get, set) {
    var inp = ce('input')
    inp.type = 'checkbox'
    inp.addEventListener('change', function () { set(!!inp.checked) })
    syncers.push(function () { inp.checked = !!get() })
    return inp
  }

  function updateUI() {
    if (syncing) return
    if (!panelEl) return
    syncing = true
    try {
      for (var i = 0; i < syncers.length; i++) { try { syncers[i]() } catch (e) {} }
      if (window.__DSH_WE_SKIN_SYNC__) { try { window.__DSH_WE_SKIN_SYNC__() } catch (e) {} }
      if (window.__DSH_WE_FIT_SYNC__) { try { window.__DSH_WE_FIT_SYNC__() } catch (e) {} }
      renderStatus()
    } finally { syncing = false }
  }

  function renderStatus() {
    var box = panelEl && panelEl.querySelector('[data-we="status"]')
    if (!box) return
    box.textContent = ''
    var eff = server && server.effective
    var cur = server && server.current
    var title = el('div', 'font-size:12.5px;font-weight:600')
    if (eff) {
      title.textContent = eff.title || '(未命名)'
      var badge = el('span', 'display:inline-block;padding:1px 6px;border-radius:6px;background:rgb(255 255 255 / 12%);font-size:11px;margin-left:6px', eff.kind === 'video' ? '视频' : '图片')
      title.appendChild(badge)
      if (eff.followed) title.appendChild(el('span', 'display:inline-block;padding:1px 6px;border-radius:6px;background:rgb(77 107 254 / 30%);font-size:11px;margin-left:6px', '跟随 WE'))
      if (eff.fallback) box.appendChild(el('div', 'color:#f0b45a;font-size:11.5px;margin-top:4px', '该壁纸是场景/网页类型（WE 的 .pkg 引擎格式），这里只能用它的预览图 —— 画质与构图都受预览图限制。'))
    } else if (cfg && !cfg.enabled) {
      title.textContent = '壁纸背景已关闭'
    } else if (!server || !server.we || !server.we.dir) {
      title.textContent = '未探测到 Wallpaper Engine'
      box.appendChild(el('div', 'color:#f0b45a;font-size:11.5px;margin-top:4px', '请在下方手动填写 Wallpaper Engine 安装目录，或确认 WE 正在运行。'))
    } else {
      title.textContent = 'WE 里当前没有已选壁纸'
    }
    box.appendChild(title)
    if (cur && cur.file) box.appendChild(el('div', 'color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11px;word-break:break-all;margin-top:2px', cur.file))
    if (mediaEl) {
      var ms
      if (mediaEl.tagName === 'VIDEO') {
        ms = 'video ' + mediaEl.videoWidth + 'x' + mediaEl.videoHeight + ' · readyState=' + mediaEl.readyState +
          ' · ' + (Math.round(mediaEl.currentTime * 10) / 10) + 's' + (mediaEl.paused ? ' · 暂停' : ' · 播放中') +
          (mediaEl.error ? ' · 错误 ' + mediaEl.error.code : '')
      } else {
        ms = 'img ' + mediaEl.naturalWidth + 'x' + mediaEl.naturalHeight + ' · ' + (mediaEl.complete ? '已加载' : '加载中')
      }
      box.appendChild(el('div', 'color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11px;margin-top:2px', ms))
      // 画质体检：这张图相对屏幕被放大了多少、会不会被裁。
      var q = qualityReport()
      if (q) box.appendChild(el('div', q.level === 'bad' ? 'color:#f0b45a;font-size:11px;margin-top:4px' : 'color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11px;margin-top:4px', q.text))
    }
    if (server && server.errors && server.errors.length) {
      box.appendChild(el('div', 'color:#ff8b7a;font-size:11px;margin-top:4px;white-space:pre-wrap;word-break:break-all', server.errors.join('\n')))
    }
  }

  // 实际生效的填充方式。场景 / 网页壁纸只能退回预览图，而预览图多是 1:1 的封面缩略图
  // （实测有 160×160、192×192、250×250、1024×1024）—— 用 cover 会被裁掉四成画面，
  // 所以默认替它们切到「模糊填满」：整张图完整显示，四周用同一张图的模糊版铺满。
  // 用户在面板里显式选过（或关掉 previewFit）时一律尊重用户的选择。
  var FIT_ORDER = ['cover', 'fill', 'contain', 'stretch']
  function effectiveFit() {
    var want = (cfg && cfg.fit) || 'cover'
    var eff = server && server.effective
    if (cfg && cfg.previewFit && eff && eff.fallback && FIT_ORDER.indexOf(want) >= 0 && want === 'cover') return 'fill'
    return want
  }
  function fitIsAuto() {
    return effectiveFit() !== ((cfg && cfg.fit) || 'cover')
  }

  // 画质体检：把「媒体原始分辨率」「屏幕」「当前填充方式」三者对上，
  // 说清楚这张图被放大了几倍、会不会被裁掉一部分。
  function qualityReport() {
    var info = mediaInfo
    if (!info || !info.w || !info.h) return null
    var vw = window.innerWidth || 1
    var vh = window.innerHeight || 1
    var dpr = window.devicePixelRatio || 1
    var fit = effectiveFit()
    var scale
    if (fit === 'contain' || fit === 'fill') scale = Math.min(vw / info.w, vh / info.h)
    else if (fit === 'cover') scale = Math.max(vw / info.w, vh / info.h)
    else scale = 1
    var eff = scale * dpr                       // 实际每个源像素被拉成多少个设备像素
    var retained = 1
    if (fit === 'cover') {
      var shownW = Math.min(vw, info.w * scale)
      var shownH = Math.min(vh, info.h * scale)
      retained = (shownW * shownH) / (info.w * scale * info.h * scale)
    }
    var parts = ['源 ' + info.w + '×' + info.h]
    if (info.preview) parts.push('预览图')
    parts.push('显示 ' + vw + '×' + vh + (dpr !== 1 ? ' @' + (Math.round(dpr * 100) / 100) + 'x' : ''))
    parts.push(scale >= 1 ? '放大 ' + (Math.round(eff * 100) / 100) + '×' : '缩小 ' + (Math.round(eff * 100) / 100) + '×')
    if (fit === 'cover' && retained < 0.92) parts.push('裁掉约 ' + Math.round((1 - retained) * 100) + '% 画面')
    var level = eff > 1.6 ? 'bad' : 'ok'
    var text = parts.join(' · ')
    if (level === 'bad') {
      text += '\n画质会被拉糊。建议：填充方式改「模糊填满」（完整显示、不裁切，四周用同图模糊补满）或「完整显示」。'
    }
    return { level: level, text: text, scale: scale, retained: retained }
  }

  function buildDiag() {
    var lines = []
    try {
      var b = document.body
      var cs = getComputedStyle(b)
      lines.push('url=' + location.href)
      lines.push('viewport=' + window.innerWidth + 'x' + window.innerHeight + ' dpr=' + window.devicePixelRatio)
      lines.push('theme dark=' + b.hasAttribute('data-ds-dark-theme') +
        ' platform=' + (document.documentElement.getAttribute('data-platform') || b.getAttribute('data-platform') || '-') +
        ' winTitlebar=' + (document.documentElement.hasAttribute('data-windows-titlebar') || b.hasAttribute('data-windows-titlebar')))
      lines.push('采样原色 base=' + orig.base + ' | sidebar=' + orig.sidebar + ' | l1=' + orig.l1)
      lines.push('当前值 bg-base=' + cs.getPropertyValue('--dsw-alias-bg-base').trim() +
        ' | sidebar-fill=' + cs.getPropertyValue('--dsw-specific-sidebar-fill').trim())
      lines.push('样式表=' + (styleEl ? styleEl.textContent.length + 'B' : '无') + ' enabled=' + (cfg && cfg.enabled) +
        ' baseAlpha=' + (cfg && cfg.baseAlpha) + ' panelAlpha=' + (cfg && cfg.panelAlpha))
      lines.push('皮肤兼容 ' + skinDiag())
      var probes = [['html', document.documentElement], ['body', document.body], ['#root', document.getElementById('root')]]
      var skinPanes = document.querySelectorAll('[data-pane="sidebar"],[class*="sidebarCol"],[data-pane="conversation"],[class*="centerCol"],[class*="_frame"]')
      for (var si = 0; si < skinPanes.length && si < 4; si++) {
        probes.push([skinPanes[si].className ? ('.' + String(skinPanes[si].className).split(' ')[0]) : skinPanes[si].tagName, skinPanes[si]])
      }
      for (var pi = 0; pi < probes.length; pi++) {
        var pe = probes[pi][1]
        if (!pe) continue
        var pc = getComputedStyle(pe)
        lines.push('  ' + probes[pi][0] + ' bg=' + pc.backgroundColor + ' bgImg=' + String(pc.backgroundImage).slice(0, 40) +
          ' sidebarFill=' + pc.getPropertyValue('--dsw-specific-sidebar-fill').trim() +
          ' bgBase=' + pc.getPropertyValue('--dsw-alias-bg-base').trim() +
          ' claudeCanvas=' + pc.getPropertyValue('--dsh-claude-canvas').trim())
      }
      var root = document.getElementById('root')
      if (root) {
        var rc = getComputedStyle(root)
        lines.push('#root bg=' + rc.backgroundColor + ' position=' + rc.position + ' z=' + rc.zIndex)
      }
      if (layerEl) {
        var lc = getComputedStyle(layerEl)
        var lr = layerEl.getBoundingClientRect()
        lines.push('图层 display=' + lc.display + ' z=' + lc.zIndex + ' rect=' + Math.round(lr.width) + 'x' + Math.round(lr.height))
      }
      if (mediaEl) {
        var mc = getComputedStyle(mediaEl)
        lines.push('媒体 ' + mediaEl.tagName + ' src=' + String(mediaEl.src).slice(0, 80) +
          ' readyState=' + (mediaEl.readyState == null ? '-' : mediaEl.readyState) +
          ' err=' + (mediaEl.error ? mediaEl.error.code + ' ' + mediaEl.error.message : '无') +
          ' opacity=' + mc.opacity + ' filter=' + mc.filter + ' fit=' + mc.objectFit)
      }
      var pts = [[Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2)],
                 [12, window.innerHeight - 12],
                 [window.innerWidth - 230, 46]]
      for (var i = 0; i < pts.length; i++) {
        var stack = (document.elementsFromPoint(pts[i][0], pts[i][1]) || []).slice(0, 6)
        var desc = []
        for (var j = 0; j < stack.length; j++) {
          var e = stack[j]
          var name = e.id ? ('#' + e.id) : (e.tagName.toLowerCase() + '.' + String(e.className || '').split(' ')[0])
          desc.push(name + '[' + getComputedStyle(e).backgroundColor + ']')
        }
        lines.push('@' + pts[i][0] + ',' + pts[i][1] + ': ' + desc.join(' > '))
      }
    } catch (e) { lines.push('诊断自身出错: ' + e.message) }
    return lines.join('\n')
  }

  function showDiag() {
    var diag = buildDiag()
    var text = '皮肤兼容 ' + skinDiag() + '\n'
    var compatSheet = compatSig ? String(compatSig.length) + 'B' : '无'
    text += '补丁样式表=' + compatSheet + ' compatEl=' + (compatEl && compatEl.isConnected ? 'in-document' : '无') +
      ' lastElementChild=' + (compatEl && document.head.lastElementChild === compatEl) + '\n'
    text += '前端配置=' + JSON.stringify(cfg || {}) + '\n'
    text += diag
    try { console.log('[dsh-wallpaper] 诊断\n' + text) } catch (e) {}
    var box = panelEl && panelEl.querySelector('[data-we="diag"]')
    if (box) { box.style.display = ''; box.value = text; try { box.select() } catch (e) {} }
    var payload = JSON.stringify({ text: text })
    fetch(BASE + '/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
      .then(function (r) { if (!r.ok) throw new Error('no /report route') })
      .catch(function () {
        // 老宿主没有 /report 路由时，退回借用 config 的 monitor 字段（无效值会被忽略，不影响跟随）
        try {
          fetch(BASE + '/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ monitor: 'DIAG::' + btoa(unescape(encodeURIComponent(text))).slice(0, 4000) }),
          }).catch(function () {})
        } catch (e) {}
      })
  }

  function buildLibrarySelect(onPick) {
    var sel = ce('select')
    var groups = {}
    var lib = (server && server.library) || []
    for (var i = 0; i < lib.length; i++) {
      var it = lib[i]
      if (!groups[it.sourceLabel]) { groups[it.sourceLabel] = ce('optgroup'); groups[it.sourceLabel].label = it.sourceLabel }
      var op = ce('option')
      op.value = it.id
      op.textContent = it.title + (it.type === 'video' ? '' : ' [' + it.type + ']')
      groups[it.sourceLabel].appendChild(op)
    }
    for (var g in groups) sel.appendChild(groups[g])
    sel.style.cssText = 'max-width:190px;min-width:0;flex:1 1 auto;background:rgb(255 255 255 / 8%);color:inherit;border:1px solid rgb(255 255 255 / 14%);border-radius:8px;padding:4px 6px;font:inherit;font-size:12px'
    sel.addEventListener('change', function () { onPick(sel.value) })
    syncers.push(function () {
      var want = cfg && cfg.follow ? '__follow__' : (cfg && cfg.manualId) || ''
      if (want && want !== '__follow__') {
        var found = false
        for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === want) { found = true; break }
        if (!found) {
          var op = ce('option')
          op.value = want
          op.textContent = '（当前：' + want + '）'
          sel.appendChild(op)
        }
      }
      sel.value = want && want !== '__follow__' ? want : (sel.options.length ? sel.options[0].value : '')
      sel.disabled = !!(cfg && cfg.follow)
      sel.style.opacity = sel.disabled ? '0.5' : ''
    })
    return sel
  }

  function buildPanel() {
    if (panelEl && panelEl.isConnected) return panelEl
    panelEl = el('div', '')
    panelEl.id = 'dsh-we-panel'

    var head = el('h4', 'margin:0 0 2px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px')
    head.appendChild(el('span', '', '🖼 壁纸背景'))
    var close = el('button', 'margin-left:auto;padding:0 7px;line-height:20px', '×')
    close.title = '关闭面板（Ctrl+Alt+W）'
    close.addEventListener('click', function () { togglePanel(false) })
    head.appendChild(close)
    panelEl.appendChild(head)
    panelEl.appendChild(el('div', 'color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11.5px', '内容来自 Wallpaper Engine'))

    var status = el('div', 'margin:8px 0 2px;padding:8px 10px;border-radius:10px;background:rgb(255 255 255 / 6%)')
    status.setAttribute('data-we', 'status')
    panelEl.appendChild(status)

    var sec1 = el('div', 'margin:10px 0 0;padding-top:10px;border-top:1px solid rgb(255 255 255 / 10%)')
    var rEnable = row('启用壁纸背景')
    rEnable.ctl.appendChild(makeCheck(function () { return cfg && cfg.enabled }, function (v) { cfg.enabled = v; applyCss(); applyMedia(); pushConfig({ enabled: v }, true) }))
    sec1.appendChild(rEnable.root)

    var rFollow = row('跟随 WE 当前壁纸')
    rFollow.ctl.appendChild(makeCheck(function () { return cfg && cfg.follow }, function (v) { cfg.follow = v; pushConfig({ follow: v }, true); updateUI(); applyMedia() }))
    sec1.appendChild(rFollow.root)

    var rPick = row('手动选择')
    rPick.ctl.appendChild(buildLibrarySelect(function (id) { cfg.follow = false; cfg.manualId = id; pushConfig({ follow: false, manualId: id }, true) }))
    sec1.appendChild(rPick.root)

    var rReload = row('WE 配置')
    var btnReload = el('button', '', '⟳ 重新读取')
    btnReload.title = '重新读取 Wallpaper Engine 的 config.json 与壁纸库'
    btnReload.addEventListener('click', function () {
      btnReload.textContent = '读取中…'
      fetch(BASE + '/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reloadWe: true }),
      }).then(function (r) { return r.json() }).then(function () { btnReload.textContent = '⟳ 重新读取'; return fetchState() })
        .catch(function () { btnReload.textContent = '⟳ 重新读取' })
    })
    rReload.ctl.appendChild(btnReload)
    sec1.appendChild(rReload.root)
    panelEl.appendChild(sec1)

    var sec2 = el('div', 'margin:10px 0 0;padding-top:10px;border-top:1px solid rgb(255 255 255 / 10%)')
    var rOp = row('壁纸不透明度')
    rOp.ctl.appendChild(makeSlider(0, 1, 0.01, function () { return cfg ? cfg.opacity : 1 }, function (v) { cfg.opacity = v; applyMedia(); pushConfig({ opacity: v }) }, function (v) { return String(Math.round(v * 100)) + '%' }))
    sec2.appendChild(rOp.root)
    var rBlur = row('壁纸模糊')
    rBlur.ctl.appendChild(makeSlider(0, 40, 1, function () { return cfg ? cfg.blur : 0 }, function (v) { cfg.blur = v; applyMedia(); pushConfig({ blur: v }) }, function (v) { return String(Math.round(v)) + 'px' }))
    sec2.appendChild(rBlur.root)
    var rDim = row('壁纸暗化')
    rDim.ctl.appendChild(makeSlider(0, 0.95, 0.01, function () { return cfg ? cfg.dim : 0 }, function (v) { cfg.dim = v; applyMedia(); pushConfig({ dim: v }) }, function (v) { return String(Math.round(v * 100)) + '%' }))
    sec2.appendChild(rDim.root)
    var rFit = row('填充方式')
    var selFit = ce('select')
    ;[['cover', '裁切铺满'], ['fill', '模糊填满（不裁切）'], ['contain', '完整显示（留黑边）'], ['stretch', '拉伸铺满']].forEach(function (o) {
      var op = ce('option'); op.value = o[0]; op.textContent = o[1]; selFit.appendChild(op)
    })
    selFit.style.cssText = 'max-width:130px;flex:0 0 auto;background:rgb(255 255 255 / 8%);color:inherit;border:1px solid rgb(255 255 255 / 14%);border-radius:8px;padding:4px 6px;font:inherit;font-size:12px'
    selFit.addEventListener('change', function () { cfg.fit = selFit.value; applyMedia(); pushConfig({ fit: selFit.value }, true); if (window.__DSH_WE_FIT_SYNC__) window.__DSH_WE_FIT_SYNC__() })
    syncers.push(function () { selFit.value = (cfg && cfg.fit) || 'cover' })
    rFit.ctl.appendChild(selFit)
    sec2.appendChild(rFit.root)

    var rPreviewFit = row('预览图自动适配')
    rPreviewFit.ctl.appendChild(makeCheck(function () { return !!(cfg && cfg.previewFit) }, function (v) {
      cfg.previewFit = v
      applyMedia()
      pushConfig({ previewFit: v }, true)
      if (window.__DSH_WE_FIT_SYNC__) window.__DSH_WE_FIT_SYNC__()
    }))
    sec2.appendChild(rPreviewFit.root)
    var fitNote = el('div', 'color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11px;margin-top:2px')
    fitNote.setAttribute('data-we', 'fitnote')
    sec2.appendChild(fitNote)
    window.__DSH_WE_FIT_SYNC__ = function () {
      try {
        var auto = fitIsAuto()
        var eff = server && server.effective
        var txt = ''
        if (auto) txt = '已自动改用「模糊填满」：场景壁纸只能用预览图（常常是正方形封面），裁切会吃掉四成画面。'
        else if (cfg && cfg.previewFit && eff && eff.fallback && cfg.fit === 'cover') txt = '（你显式选了裁切铺满，自动适配不再介入）'
        if (fitNote.textContent !== txt) fitNote.textContent = txt
      } catch (e) {}
    }
    panelEl.appendChild(sec2)

    var sec3 = el('div', 'margin:10px 0 0;padding-top:10px;border-top:1px solid rgb(255 255 255 / 10%)')
    sec3.appendChild(el('div', 'color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11.5px;margin-bottom:2px', 'DSH 界面透明度（越小壁纸越明显）'))
    var rBase = row('界面底材保留')
    rBase.ctl.appendChild(makeSlider(0, 1, 0.01, function () { return cfg ? cfg.baseAlpha : 1 }, function (v) { cfg.baseAlpha = v; applyCss(); pushConfig({ baseAlpha: v }) }, function (v) { return String(Math.round(v * 100)) + '%' }))
    sec3.appendChild(rBase.root)
    var rPanel = row('面板层保留')
    rPanel.ctl.appendChild(makeSlider(0, 1, 0.01, function () { return cfg ? cfg.panelAlpha : 1 }, function (v) { cfg.panelAlpha = v; applyCss(); pushConfig({ panelAlpha: v }) }, function (v) { return String(Math.round(v * 100)) + '%' }))
    sec3.appendChild(rPanel.root)
    panelEl.appendChild(sec3)

    // ---- 皮肤兼容（dsh-claude-style 等）------------------------------------
    var secSkin = el('div', 'margin:10px 0 0;padding-top:10px;border-top:1px solid rgb(255 255 255 / 10%)')
    secSkin.appendChild(el('div', 'color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11.5px;margin-bottom:2px', '皮肤兼容（Claude Code 风格等）'))
    var skinStatus = el('div', 'font-size:11px;color:var(--dsw-alias-label-secondary,#a9aeb6);word-break:break-all')
    skinStatus.setAttribute('data-we', 'skin')
    secSkin.appendChild(skinStatus)

    var rSkinOn = row('透出壁纸')
    rSkinOn.ctl.appendChild(makeCheck(function () { return !!(cfg && cfg.skinCompat) }, function (v) {
      cfg.skinCompat = v
      applyCompatCss()
      pushConfig({ skinCompat: v }, true)
      syncersSkin()
    }))
    secSkin.appendChild(rSkinOn.root)

    // 皮肤把画布色画在内容列/侧栏上（不透明度跟着界面底材走）；100% = 跟随界面底材。
    var skinAlphaValue = function () {
      if (!cfg) return 1
      return cfg.skinAlpha == null ? cfg.baseAlpha : cfg.skinAlpha
    }
    var skinFrameValue = function () {
      if (!cfg) return 1
      var b = cfg.skinAlpha == null ? cfg.baseAlpha : cfg.skinAlpha
      return cfg.skinFrameAlpha == null ? b : cfg.skinFrameAlpha
    }
    var skinSliderCss = 'flex:0 0 46px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11.5px'

    var rSkinAlpha = row('皮肤画布保留')
    var wrapSkin = el('div', 'display:flex;align-items:center;gap:6px;flex:1 1 auto;justify-content:flex-end')
    var inpSkin = ce('input')
    inpSkin.type = 'range'; inpSkin.min = '0'; inpSkin.max = '1'; inpSkin.step = '0.01'
    var valSkin = el('span', skinSliderCss)
    inpSkin.addEventListener('input', function () {
      var v = Number(inpSkin.value)
      cfg.skinAlpha = v >= 1 ? null : v
      applyCompatCss()
      pushConfig({ skinAlpha: cfg.skinAlpha })
      syncersSkin()
    })
    wrapSkin.appendChild(inpSkin); wrapSkin.appendChild(valSkin)
    rSkinAlpha.ctl.appendChild(wrapSkin)
    secSkin.appendChild(rSkinAlpha.root)

    var rSkinFrame = row('窗口外框保留')
    var wrapFrame = el('div', 'display:flex;align-items:center;gap:6px;flex:1 1 auto;justify-content:flex-end')
    var inpFrame = ce('input')
    inpFrame.type = 'range'; inpFrame.min = '0'; inpFrame.max = '1'; inpFrame.step = '0.01'
    var valFrame = el('span', skinSliderCss)
    inpFrame.addEventListener('input', function () {
      var v = Number(inpFrame.value)
      cfg.skinFrameAlpha = v >= skinAlphaValue() ? null : v
      applyCompatCss()
      pushConfig({ skinFrameAlpha: cfg.skinFrameAlpha })
      syncersSkin()
    })
    wrapFrame.appendChild(inpFrame); wrapFrame.appendChild(valFrame)
    rSkinFrame.ctl.appendChild(wrapFrame)
    secSkin.appendChild(rSkinFrame.root)

    var rSkinReapply = row('补丁状态')
    var btnSkin = el('button', '', '↻ 重新应用')
    btnSkin.title = '重新注入兼容补丁（皮肤晚于壁纸加载时用得上）'
    btnSkin.addEventListener('click', function () {
      try { refreshCompatSoon(0) } catch (e) {}
      setTimeout(function () { try { applyCompatCss(); syncersSkin(); renderStatus() } catch (e) {} }, 120)
    })
    rSkinReapply.ctl.appendChild(btnSkin)
    secSkin.appendChild(rSkinReapply.root)
    panelEl.appendChild(secSkin)

    // 皮肤区块自己的同步：只拷状态行与两个滑杆的可用态，不进入全局 syncers，
    // 免得每轮轮询都白写一遍 DOM。
    function syncersSkin() {
      try {
        var skinOn = !!(document.body && document.body.hasAttribute(SKIN_ATTR))
        var on = !!(cfg && cfg.skinCompat)
        var usable = skinOn && on && !!(cfg && cfg.enabled)
        inpSkin.disabled = !usable
        inpFrame.disabled = !usable
        inpSkin.style.opacity = usable ? '' : '0.5'
        inpFrame.style.opacity = usable ? '' : '0.5'
        if (skinStatus) {
          var txt = !skinOn
            ? '未检测到皮肤（启用 dsh-claude-style 后自动生效）'
            : (!on ? '已关闭：皮肤的实色画布会盖住壁纸'
              : (usable ? '生效中 · 画布 ' + pct(skinAlphaValue()) + ' · 外框 ' + pct(skinFrameValue()) : '壁纸背景已关闭'))
          if (skinStatus.textContent !== txt) skinStatus.textContent = txt
        }
        var av = skinAlphaValue()
        var fv = skinFrameValue()
        if (document.activeElement !== inpSkin) inpSkin.value = String(av)
        if (document.activeElement !== inpFrame) inpFrame.value = String(fv)
        valSkin.textContent = av >= 1 ? '跟随' : pct(av)
        valFrame.textContent = fv >= skinAlphaValue() ? '跟随' : pct(fv)
      } catch (e) {}
    }
    syncersSkin()
    window.__DSH_WE_SKIN_SYNC__ = syncersSkin

    var sec4 = el('div', 'margin:10px 0 0;padding-top:10px;border-top:1px solid rgb(255 255 255 / 10%)')
    var rMute = row('静音')
    rMute.ctl.appendChild(makeCheck(function () { return cfg && cfg.muted }, function (v) { cfg.muted = v; applyMedia(); pushConfig({ muted: v }, true) }))
    sec4.appendChild(rMute.root)
    var rVol = row('音量')
    rVol.ctl.appendChild(makeSlider(0, 1, 0.01, function () { return cfg ? cfg.volume : 0 }, function (v) { cfg.volume = v; cfg.muted = false; applyMedia(); pushConfig({ volume: v, muted: false }) }, function (v) { return String(Math.round(v * 100)) + '%' }))
    sec4.appendChild(rVol.root)
    var rPause = row('暂停播放')
    rPause.ctl.appendChild(makeCheck(function () { return cfg && cfg.paused }, function (v) { cfg.paused = v; applyMedia(); pushConfig({ paused: v }, true) }))
    sec4.appendChild(rPause.root)
    panelEl.appendChild(sec4)

    var sec5 = el('div', 'margin:10px 0 0;padding-top:10px;border-top:1px solid rgb(255 255 255 / 10%)')
    var rBtn = row('显示悬浮按钮')
    rBtn.ctl.appendChild(makeCheck(function () { return cfg && cfg.showButton }, function (v) { cfg.showButton = v; applyButton(); pushConfig({ showButton: v }, true) }))
    sec5.appendChild(rBtn.root)
    var rWeDir = row('WE 目录')
    var inpDir = ce('input')
    inpDir.type = 'text'
    inpDir.placeholder = '留空=自动探测，如 D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine'
    inpDir.style.cssText = 'flex:1 1 auto;min-width:0;background:rgb(255 255 255 / 8%);color:inherit;border:1px solid rgb(255 255 255 / 14%);border-radius:8px;padding:4px 6px;font:inherit;font-size:11.5px'
    inpDir.addEventListener('change', function () {
      var v = inpDir.value.trim()
      fetch(BASE + '/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weDir: v || null, weDirPinned: !!v, reloadWe: true }) })
        .then(function (r) { return r.json() }).then(function () { return fetchState() }).catch(function () {})
    })
    syncers.push(function () { if (document.activeElement !== inpDir) inpDir.value = (cfg && cfg.weDir) || '' })
    rWeDir.ctl.appendChild(inpDir)
    sec5.appendChild(rWeDir.root)
    panelEl.appendChild(sec5)

    var btnDiag = el('button', '', '诊断')
    btnDiag.title = '把页面实况（采到的原色、各层的背景、媒体状态）打印出来，排查“壁纸没透出来”用'
    btnDiag.addEventListener('click', function () { showDiag() })
    var footRow = el('div', 'display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid rgb(255 255 255 / 10%)')
    footRow.appendChild(btnDiag)
    footRow.appendChild(el('span', 'color:var(--dsw-alias-label-secondary,#a9aeb6);font-size:11px;word-break:break-all;flex:1 1 auto', (server && server.configFile) || '~/.dsh/.dsh-wallpaper.json'))
    panelEl.appendChild(footRow)
    var diagBox = el('textarea', 'display:none;width:100%;height:150px;margin-top:8px;box-sizing:border-box;background:rgb(0 0 0 / 35%);color:inherit;border:1px solid rgb(255 255 255 / 14%);border-radius:8px;padding:6px;font:11px/1.45 ui-monospace,Consolas,monospace')
    diagBox.setAttribute('data-we', 'diag')
    diagBox.readOnly = true
    panelEl.appendChild(diagBox)

    document.body.appendChild(panelEl)
    renderStatus()
    return panelEl
  }

  function panelAnchor() {
    var r = btnEl ? btnEl.getBoundingClientRect() : { left: 14, top: (window.innerHeight - 50), width: 36, height: 36, bottom: window.innerHeight - 14 }
    var w = 330
    var left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8))
    var top = r.top - 12
    var maxTop = window.innerHeight - 120
    if (top > maxTop) top = maxTop
    if (top < 8) top = 8
    panelEl.style.left = String(Math.round(left)) + 'px'
    panelEl.style.top = String(Math.round(top)) + 'px'
    panelEl.style.bottom = 'auto'
  }

  function togglePanel(show) {
    var want = show == null ? !(panelEl && panelEl.style.display !== 'none') : show
    if (want) { buildPanel(); panelEl.style.display = ''; panelAnchor(); updateUI(); fetchState() }
    else if (panelEl) panelEl.style.display = 'none'
  }

  // -------------------------------------------------------------------------
  // 悬浮按钮（可拖动）
  // -------------------------------------------------------------------------
  function applyButton() {
    if (!btnEl) return
    var show = cfg ? cfg.showButton !== false : true
    btnEl.style.display = show ? '' : 'none'
    btnEl.setAttribute('data-active', cfg && cfg.enabled ? '1' : '0')
    if (cfg && cfg.btnPos) {
      btnEl.style.left = String(cfg.btnPos.x) + 'px'
      btnEl.style.top = String(cfg.btnPos.y) + 'px'
      btnEl.style.right = 'auto'
      btnEl.style.bottom = 'auto'
    } else {
      btnEl.style.left = '14px'
      btnEl.style.top = 'auto'
      btnEl.style.right = 'auto'
      btnEl.style.bottom = '14px'
    }
  }

  function buildButton() {
    if (btnEl && btnEl.isConnected) return
    btnEl = el('div', '', '🖼')
    btnEl.id = 'dsh-we-btn'
    btnEl.title = '壁纸背景（点击打开设置，拖动可移动；Ctrl+Alt+W）'
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0
    btnEl.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false
      sx = e.clientX; sy = e.clientY
      var r = btnEl.getBoundingClientRect()
      ox = r.left; oy = r.top
      try { btnEl.setPointerCapture(e.pointerId) } catch (err) {}
      e.preventDefault()
    })
    btnEl.addEventListener('pointermove', function (e) {
      if (!dragging) return
      var dx = e.clientX - sx, dy = e.clientY - sy
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true
      if (!moved) return
      var x = Math.max(0, Math.min(window.innerWidth - 36, ox + dx))
      var y = Math.max(0, Math.min(window.innerHeight - 36, oy + dy))
      btnEl.style.left = String(Math.round(x)) + 'px'
      btnEl.style.top = String(Math.round(y)) + 'px'
      btnEl.style.right = 'auto'
      btnEl.style.bottom = 'auto'
    })
    btnEl.addEventListener('pointerup', function (e) {
      if (!dragging) return
      dragging = false
      try { btnEl.releasePointerCapture(e.pointerId) } catch (err) {}
      if (moved) {
        var r = btnEl.getBoundingClientRect()
        cfg.btnPos = { x: Math.round(r.left), y: Math.round(r.top) }
        pushConfig({ btnPos: cfg.btnPos }, true)
      } else {
        togglePanel()
      }
    })
    document.body.appendChild(btnEl)
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  function start() {
    try {
      ensureStyle()
      ensureLayer()
      buildButton()
      applyButton()
      fetchState()
      if (window.__DSH_WE_TIMER__) clearInterval(window.__DSH_WE_TIMER__)
      window.__DSH_WE_TIMER__ = setInterval(fetchState, POLL_MS)
      document.addEventListener('visibilitychange', function () { applyMedia() })
      document.addEventListener('keydown', function (e) {
        if (e.ctrlKey && e.altKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); togglePanel() }
      })
      try {
        var mo = new MutationObserver(function () {
          if (window.__DSH_WE_THEME_T__) clearTimeout(window.__DSH_WE_THEME_T__)
          window.__DSH_WE_THEME_T__ = setTimeout(refreshOriginals, 60)
        })
        // 只盯主题属性：绝不能观察 'style'，因为 applyCss() 自己会写 body 的内联变量，
        // 否则观察者会被自己的写入触发，形成 60ms 一轮的死循环。
        mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      } catch (e) {}
      // 皮肤兼容层：盯 <head> 直接子节点的增删（皮肤是在运行时 append 样式表的），
      // 另外每次切换主题/品牌属性时也重算一次。
      watchHead()
      try {
        var mo2 = new MutationObserver(function () { refreshCompatSoon(80) })
        mo2.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-dsh-claude-style', 'data-dsh-claude-brand', 'data-ds-dark-theme'],
        })
      } catch (e) {}
      refreshCompatSoon(60)
      window.addEventListener('resize', function () { if (panelEl && panelEl.style.display !== 'none') panelAnchor() })
      log('started')
    } catch (e) { log('start failed', e) }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
