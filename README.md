# dsh-wallpaper-engine

把 **Wallpaper Engine** 的壁纸接进 **DeepSeek Harness** 的界面背景：DSH 的底材变成半透明，
壁纸在界面底下动起来；默认跟随 WE 当前正在用的那张，也可以在面板里挑任意一张已安装壁纸。

## 效果与能力

- 🖼 **跟随 WE 当前壁纸**：读 Wallpaper Engine 的 config.json，自动用你桌面上正在放的那张
- 📚 **手动挑选**：创意工坊 / 本地壁纸 / 内置壁纸 三组，随便换（不用改桌面壁纸）
- 🎚 **可调**：壁纸不透明度、模糊、暗化、填充方式（裁切 / 模糊填满 / 完整 / 拉伸）
- 🔍 **画质体检**：面板会报出「源 250×250 · 预览图 · 显示 1920×1080 @1.5x · 放大 11.5× · 裁掉约 44% 画面」，
  并给出该换成哪种填充方式的建议
- 🧩 **预览图自动适配**：场景 / 网页壁纸只能退回预览图，而预览图多是 **1:1 的封面缩略图**
  （实测 160×160 ~ 1024×1024）；默认自动切到「模糊填满」，整张图完整显示、四周用同图模糊补满，
  不再被裁掉四成画面（见下节）
- 🪟 **界面透明程度**：底材（--dsw-alias-bg-base）与面板层（layer-1/2/3）各一条滑杆；
  底材调低 = 壁纸更明显，面板层调低 = 卡片也变玻璃
- 🧩 **皮肤兼容**：和 dsh-claude-style 这类“整页换肤”插件共存时，皮肤的实色画布会盖住壁纸 ——
  插件会自动注入一段补丁 CSS 把皮肤的六处画布一起调淡（见下节），壁纸照常透出来
- 🔇 视频壁纸静音 / 音量 / 暂停；窗口隐藏时自动暂停，省 GPU
- 🖐 左下角悬浮按钮，**可拖动**（位置会记住）；快捷键 **Ctrl+Alt+W** 开合面板
- ❌ 关掉开关后 DSH 立刻恢复原样（不残留透明样式）

## 原理

| 环节 | 做法 |
|---|---|
| 拿“当前壁纸” | 解析 WE 安装目录下 config.json 的 general.wallpaperconfig.selectedwallpapers（按显示器） |
| 建壁纸库 | 扫 steamapps/workshop/content/431960/* 与 WE 的 projects/myprojects、projects/defaultprojects 里的 project.json |
| 找 WE 安装目录 | ① 用户手动钉住的目录 ② 正在运行的 wallpaper64.exe 进程路径 ③ 注册表 SteamPath + libraryfolders.vdf 里的各 Steam 库；同组内优先“配置里有已选壁纸”的那份（机器上装了两份 WE 时，靠这条选中正在用的那份） |
| 媒体怎么给页面 | 插件注册 /dsh-we-wallpaper/media，从磁盘流式发送，**支持 Range**（200 / 206 / 416 / 后缀区间） |
| 前端怎么进页面 | webserver/index-inject 的结构化 script 行 —— 桌面端 Electron **唯一**能生效的通道 |
| 怎么变透明 | 先用 getComputedStyle 采样本主题的原始底色，再用 color-mix(in srgb, 原色 N%, transparent) 以 !important 覆盖；切换主题时重新采样。**必须覆盖两个 token**：内容列的 --dsw-alias-bg-base，以及 Windows 桌面端外框 / 侧栏的 --dsw-specific-sidebar-fill —— 后者是 [data-windows-titlebar] .BynINW_frame 的底色，只改前者的话壁纸会被整个外框盖住（第一版正是踩了这个坑） |

## 场景 / 网页壁纸的画质（预览图这条路）

Wallpaper Engine 的场景（`scene.pkg` / `scene.json`）与网页壁纸用的是 **WE 自己的引擎格式**，
浏览器里没有能直接播它的东西 —— 这个插件能拿到的只有项目目录里的**预览图**，
而那是 Steam 创意工坊的**封面缩略图**，实测本机几张：

| 壁纸 | 预览图 | 分辨率 |
|---|---|---|
| Pixels | preview.gif | 192×192 |
| ATRI-My Dear Moments | preview.gif | 250×250 |
| 2K ATRI绝美的星空 | preview.jpg | 1024×1024 |
| Blue Archive-圣园未花[4K] | preview.gif | 160×160 |

所以在 1920×1080 上会同时踩两个坑：

1. **裁切不对**：1:1 方图用 `cover` 会被放大到 1920 宽，再裁掉约 **44%** 的画面高度
   （上下各去掉两成多），构图整个变样；
2. **分辨率降低**：160×160 要放大 12 倍、1024×1024 要放大 1.875 倍才铺得满，
   1024 的还算能看，192 以下基本就是糊的。

插件做了三件事：

- **从 scene.pkg 解出真实画面**（`sceneExtract`，默认开）：直接读 WE 的私有容器，
  把里面的画面取出来当壁纸用 —— 内嵌的 MP4/PNG/JPEG 原样直出，裸像素（RGBA8888、
  DXT1/3/5，带 LZ4 压缩的）自己解码后编码成 PNG。**本机 18 张场景壁纸全部提取成功**
  （12 张图片 + 6 段视频，总耗时约 5 秒），例如 Pixels 拿到 1080×1080 的 MP4、
  亚托莉 8K 那张拿到 7680×4320 的 PNG。取不到才退回预览图。
- **预览图自动适配**（`previewFit`，默认开）：万一只剩预览图可用，检测到当前是预览图、
  且你选的是「裁切铺满」时，自动改用 **「模糊填满」** —— 前台把整张图 `contain` 完整放进屏幕，
  背景用同一张图放大 1.22 倍、模糊 46px 铺满，于是**既不裁切、也不留黑边**。
  你在面板里显式选过别的填充方式，或关掉这个开关，它就完全不插手。
- **画质体检**：面板状态区直接告诉你有多少源像素、被放大几倍、裁掉多少，
  放大超过 1.6× 会标黄并给建议。

### 画面是怎么挑出来的

场景不是一张图，而是「材质 + 模型 + 着色器 + 相机」的场景图，重建它等于写一个渲染器。
本插件不做渲染，只从 pkg 里挑**最像壁纸的那一层**，规则按优先级：

1. 所有候选**统一评分**：`log2(面积)` + 横向构图加分（1.2~2.8 宽高比）+6 − 纵向 −3，
   再按**不透明像素占比**修正（<6% 的重罚 −12，那是透明背景上的花瓣/光斑/UI 精灵）；
2. 内嵌视频/图片比需要解码的裸像素多 0.6 分（只是偏好，压不过画面本身的差距）；
3. 挑中的是哪一层会**显示在面板里**（`画面取自 scene.pkg：materials/xxx.tex · 3840×2160 · DXT5`），
   不假装是完整场景渲染。

**取单层不对的场景，用预览图。** 有些场景是**多层拼接 + 逐层视差跟随鼠标**，合成结果跟任何单层
都不是一回事 —— 本机实测 `Blue Archive 圣园未花[4K]`：`scene.json` 里 68 个对象、57 处 `parallax`、
170 处 `cursor`，而它最大的那层只是一片夜空云层（角色、阳台、光环都在别的层里），
作者给的预览图反而是对的合成画面：

| 作者预览图（合成结果） | 我提取到的最大层（只是其中一层） |
|---|---|
| 角色 + 阳台 + 夜空 + 光环 | 只有夜空云层 |

这类**没有可靠的自动判据**：颜色直方图与 16×16 亮度网格都试过，两者都分不开「对的层」与「错的层」
（实测抓错的那张亮度相似度 0.852，反而比抓对的 ATRI 0.809 更高）。所以交给用户点名 ——
面板里勾**「用预览图（当前这张）」**，值存进 `scenePreviewIds`。默认已包含 `ws:3596044309`。

### 格式支持与实测覆盖

| 载荷 | 处理 | 本机实测 |
|---|---|---|
| 内嵌 MP4 / PNG / JPEG / GIF | 原样直出，零解码 | 19 个纹理 |
| 裸像素 RGBA8888 | 通道重排 → 自写 PNG 编码 | 44 个纹理（含 LZ4） |
| DXT1 / DXT3 / DXT5 | 手写块解码 → PNG | 9 个纹理（含 LZ4） |
| LZ4 块压缩 | 手写解压（无依赖） | 44 个纹理用到 |

容器格式（`PKGV00xx` 条目表、`TEXV0005`/`TEXI0001`/`TEXB000x` 纹理块）按
[RePKG](https://github.com/notscuffed/repkg) 的实现逐一核对，并用两个独立的正确性判据验收：
「条目尺寸合计 === 文件大小 − 数据区起点」、「解压后字节数 ÷ 像素数 === 该格式的每像素字节数
（DXT5 = 0.25、DXT1 = 0.125）」。提取结果缓存到 `$DSH_HOME/.dsh-wallpaper-cache/`，
缓存键是 pkg 的 mtime+size，所以只在壁纸真的变了以后才重解。

## 皮肤兼容层（dsh-claude-style 等）

### 为什么会互相盖住

dsh-claude-style 走的是“整页换肤”的路子：它不满足于改主题变量，而是**把实色画布直接画在
内容列 / 侧栏 / 窗口外框上**，关键几处还带 !important：

| 皮肤规则（选择器权重） | 写的东西 |
|---|---|
| `body[data-dsh-claude-style]:not([data-ds-dark-theme]) #root` (1,3,1) | `background-color: var(--dsh-claude-canvas) !important` |
| `body[data-dsh-claude-style]:not([data-ds-dark-theme]) :is([data-pane="conversation"], [class*="centerCol"])` (0,5,1) | 同上，对话列 |
| `body[data-dsh-claude-style] :is([data-pane="sidebar"], [class*="sidebarCol"], …)` (0,3,1) | `--dsw-specific-sidebar-fill` + `background` 都是 `!important` |
| `span[data-dsh-claude-style]:not([data-ds-dark-theme])` / `html:has(body[…])` | html / body 的画布色 |

而本插件是靠**调淡 --dsw-* 变量**让壁纸透出来的：这些实色值根本不读变量，
皮肤一启用，链接里的界面就整块变成它的暖黑 `#141413`，壁纸被压在下面看不见。

### 补丁做了什么

只在这些选择器上把皮肤的画布色按同一比例调淡（`--dsh-we-canvas` = 原画布色 × α）：

- `#root`、对话列（`[data-pane="conversation"]` / `[class*="centerCol"]`）
- 侧栏（`[data-pane="sidebar"]` / `[class*="sidebarCol"]` / `.dshDesktopSidebarSurface`）—— 元素自身的 background 和它声明的 `--dsw-specific-sidebar-fill` 一起接管
- 窗口外框 `[class*="_frame"]` 与它的 `::before`（Windows 标题栏条）
- `html` / `body`
- 皮肤自己的两个画布 token `--dsh-claude-canvas` / `--dsh-claude-sidebar-canvas`（让它内部仍用变量画的地方，如搜索面板与用量卡片，也一起透）

皮肤的配色、排版、字体、交互一律不碰。

### 三个让它稳定生效的细节

1. **特异性**：皮肤是 (0,3,1)~(0,5,1) 且带 !important，补丁用属性选择器加倍到 (0,7,1)~(0,9,1)，
   两种声明方式都比它高 —— 不用赌样式表顺序。
2. **顺序**：皮肤的样式表是运行时 append 到 `<head>` 的，补丁每次应用都把自己挪到 `<head>` 末尾，
   并用一个只盯 `<head>` 直接子节点的 MutationObserver 在皮肤插入后 80ms 内重算一次。
3. **变量传播**：皮肤的画布色是继承变量，变量在 body 上被覆盖成半透明后，侧栏规则里的
   **!important 会把“带 !important 的父级值”重新捡回去** —— 所以补丁必须把侧栏元素自己的
   background 也一并接管，只改变量是不够的。

补丁的限域属性是 `html[data-dsh-we-compat]` / `body[data-dsh-we-compat]`：皮肤关掉、壁纸关掉、
或把画布保留拉到 100% 时，补丁连同属性一起撤掉，页面不留痕迹。

### 怎么调

面板里新增一段「皮肤兼容（Claude Code 风格等）」：

| 面板项 | 说明 |
|---|---|
| 透出壁纸 | 补丁开关（默认开）。未装皮肤时自动不生效 |
| 皮肤画布保留 | 内容列 / 侧栏的画布不透明度；**100% = 跟随“界面底材保留”** |
| 窗口外框保留 | 顶部标题栏与外框的那圈颜色；**100% = 跟随皮肤画布** |
| ↻ 重新应用 | 手动重算一次（皮肤晚于壁纸加载时用得上） |

想要“皮肤味道更足、壁纸淡一点”就把两条滑杆往大调；想让壁纸更抢眼就往小调。
当前状态（检测到的皮肤、生效比例、补丁样式表大小）会显示在这一段的第一行，
点面板底部的「诊断」能把六处画布的计算值一起打出来。

## 安装

四种装法，按推荐顺序：

### ① 插件管理器（DSH 界面里那页）

把下面任意一个 spec 填进插件管理页的安装框：

| spec | 说明 |
|---|---|
| `https://github.com/Ra-fangtang/dsh-wallpaper-engine/releases/download/v0.2.0/dsh-wallpaper-engine-0.2.0.tgz` | **发行版附件**，钉死版本、不跑任何构建脚本，最稳（把版本号换成你要的那个） |
| `github:Ra-fangtang/dsh-wallpaper-engine` | 跟着 `main` 走，pnpm 会 git clone |
| `dsh-wallpaper-engine` | 如果它已经发布到 npm registry |

命令行等价：

```bash
dsh plugin --profile <web|desktop> add github:Ra-fangtang/dsh-wallpaper-engine
```

> 桌面端 profile 由 Electron 应用独占管理（`dsh plugin --profile desktop` 会被拒绝），
> 桌面端请走 ②。

### ② 从源码目录装（开发时最顺手）

```bash
dsh plugin --profile <web> add link:<你 clone 下来的插件目录>
```

### ③ 手动挂载

在 `%USERPROFILE%\.dsh\profiles\<profile>\` 下改两处、建一个 junction：

1. `package.json`
   - `dependencies` 加 `"dsh-wallpaper-engine": "link:<插件目录的绝对路径>"`
     （跟 GitHub 上游走就写 `github:Ra-fangtang/dsh-wallpaper-engine`）
   - `dsh.profile.bundles` 加 `"dsh-wallpaper-engine"`
2. `node_modules\dsh-wallpaper-engine` → 指向插件目录的 junction：

       cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-wallpaper-engine" "<插件目录的绝对路径>"

### ④ 从 Git 历史里装出来的坑

从 git/github spec 安装时，pnpm 会把这个包当“需要构建”的包，拦下它的生命周期脚本要你授权
（`pendingBuilds` / `allowBuilds`）。**本插件没有任何依赖与构建步骤**，所以仓库里刻意不声明
`prepare` 脚本；如果你的 pnpm 仍然弹出授权请求，直接选“不允许”即可 —— 它不构建也能跑。

### ⚠️ 装完必须重启一次 DSH

宿主（桌面端是 `dsh-desktop-host` 的 `collectIndexInjections()` → IPC → 渲染层）的**页面注入表在启动时只收集一次**，
热挂载进来的插件赶不上这一趟。所以：**完全退出 DSH 再打开**，页面才会加载 client.js。

宿主侧（路由）不需要重启：热挂载后立刻可用，可直接验证：

    GET http://127.0.0.1:19387/dsh-we-wallpaper/state

## 使用

左下角 **🖼** 按钮（可拖到任意位置，位置记在配置里）：
点击 = 开合面板；拖动 = 移动。快捷键 **Ctrl+Alt+W** 同样开合面板。

| 面板项 | 说明 |
|---|---|
| 启用壁纸背景 | 总开关，关掉后界面完全恢复原样 |
| 跟随 WE 当前壁纸 | 勾上 = 用桌面上正在放的那张；取消 = 用手动选择 |
| 手动选择 | 从壁纸库里挑（创意工坊 / 本地壁纸 / 内置壁纸） |
| ⟳ 重新读取 | 重新探测 WE 目录、重读 config.json、重建壁纸库 |
| 壁纸不透明度 / 模糊 / 暗化 | 壁纸自身的呈现 |
| 填充方式 | 裁切铺满 / **模糊填满（不裁切）** / 完整显示（留黑边）/ 拉伸铺满 |
| 预览图自动适配 | 场景/网页壁纸退回预览图时自动用「模糊填满」，见上节 |
| 界面底材保留 | **越小壁纸越明显**（默认 62%） |
| 面板层保留 | 卡片、菜单等面板的不透明度（默认 100% = 不变） |
| 透出壁纸 / 皮肤画布保留 / 窗口外框保留 | 皮肤兼容层，见上一节 |
| 静音 / 音量 / 暂停播放 | 只对视频壁纸有意义 |
| 显示悬浮按钮 | 关掉后按钮隐藏（Ctrl+Alt+W 仍能叫出面板） |
| WE 目录 | 留空 = 自动探测；手填后会**钉住**，不再被自动探测覆盖 |

## 已知限制

- **场景（.pkg）/ 网页（.html）壁纸无法渲染**：那是 Wallpaper Engine 自己的引擎格式，
  插件会退回用它的**预览图**（面板里会明确提示）。想要动态效果就用视频类壁纸。
- **“跟随”不是实时的**：WE 只在保存设置 / 退出时才写 config.json，
  所以在 WE 里换了壁纸后，点一下面板里的 **⟳ 重新读取** 即可。
- 视频壁纸是**第二路解码**（桌面已经在放一份），4K 大壁纸会多占一点 GPU；
  不需要时把“启用”关掉，或把不透明度 / 模糊调低。
- 路由只认回环（127.0.0.1 / localhost）、桌面壳（dsh-app）与无 Host 的 IPC 桥请求；
  带 Sec-Fetch-Site: cross-site 或异源 Origin 的请求一律 403。

## 文件与运行时数据

| 路径（相对插件目录） | 用途 |
|---|---|
| lib/index.js | 宿主侧：WE 探测、壁纸库、路由、注入行 |
| assets/wallpaper-client.js | 前端：背景层、透明化、皮肤兼容补丁、面板（宿主**按 mtime 热读取**，重启后立刻用上新版本；但打包版桌面端没有“刷新页面”菜单、页面不会自行重载，所以前端改动仍需重启一次 DSH） |
| cordis.patch.yml | bundle 挂载声明 |
| %USERPROFILE%\.dsh\.dsh-wallpaper.json | 运行时配置（开关、滑杆值、按钮位置、WE 目录） |

## 卸载

1. 删掉 profile 的 `node_modules\dsh-wallpaper-engine` junction
2. 删掉 profile `package.json` 里的依赖行与 bundles 行
3. 重启 DSH；配置残留 `%USERPROFILE%\.dsh\.dsh-wallpaper.json` 可一并删除

## 排查

| 现象 | 处理 |
|---|---|
| 面板显示“未探测到 Wallpaper Engine” | 把 WE 安装目录填进“WE 目录”（例如 `D:\SteamLibrary\steamapps\common\wallpaper_engine`）后回车 |
| 按钮 / 面板都没出现 | 页面注入行没生效 → **重启 DSH**；或确认 GET /dsh-we-wallpaper/state 返回 200 |
| 壁纸没透出来 | 把“界面底材保留”往小调；确认“启用壁纸背景”是勾上的 |
| 启用 dsh-claude-style 后壁纸被盖住 | 确认面板「皮肤兼容」一段的“透出壁纸”是勾上的；状态行应显示 `生效中`。若显示“未检测到皮肤”，说明皮肤不是通过 `body[data-dsh-claude-style]` 挂载的，需要在 wallpaper-client.js 的 `SKIN_ATTR` / `buildCompatCss()` 里补选择器 |
| 皮肤/壁纸都正常但某一块仍是不透明 | 点「诊断」，`皮肤兼容` 那几行会列出 html/body/#root/侧栏/对话列/外框 的计算背景色；哪一行 alpha 是 1，就把对应的滑杆往小调（或把该选择器补进补丁） |
| 面板显示“已改用预览图” | 当前是场景 / 网页壁纸，换一张视频类壁纸即可 |
| 换了 WE 壁纸但 DSH 没变 | 点“⟳ 重新读取” |
| 勾了启用却看不到壁纸 | 点面板底部「诊断」：它会列出采到的原色、当前 token 值、覆盖点各层的背景色与媒体状态，能直接看出是哪一层还不透明、或视频有没有加载 |

## 安全边界

插件只做三件事：读 WE 的配置与壁纸文件、把媒体流给本机页面、写自己的配置文件。
不联网、不改 Wallpaper Engine 的任何文件、不注入 WE 进程。

