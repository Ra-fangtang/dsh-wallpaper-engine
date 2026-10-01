# 发版手册

给自己看的清单。目标是「一条命令自检 → 打标签 → 把 tarball 挂到 Release」。

## 为什么要有发行版（而不是只推 main）

DSH 的插件管理器接受四类安装 spec（`@deepseek-ai/dsh-plugin-manager` 的 `parseInstallSpec`）：

| spec 形式 | 例子 | 安装走什么 |
|---|---|---|
| registry 包名 | `dsh-wallpaper-engine` / `dsh-wallpaper-engine@0.2.0` | pnpm 从 registry 拉 tarball |
| git 简写 / git URL | `github:Ra-fangtang/dsh-wallpaper-engine` | `git clone`（含 `git ls-remote` 预检） |
| **tarball URL** | `https://github.com/<owner>/<repo>/releases/download/v0.2.0/dsh-wallpaper-engine-0.2.0.tgz` | 直接 HTTPS 下载，**不跑任何构建脚本** |
| 本地绝对路径 | `link:D:\Plugins\dsh-wallpaper-engine` / `file:...tgz` | 直接指过去 |

发行版 = **git 标签 + Release 附件（tarball）**，它给的是：

1. **版本可钉**：别人能写 `.../v0.2.0/...tgz`，跟着 main 走就不会被你的改动影响；
2. **不触发构建脚本审批**：tarball 与 registry spec 不经过 git，pnpm 不会拦 `prepare`
   （本插件本来也没有构建步骤，但 git spec 那条路 pnpm 仍会提示授权，体验差）；
3. **可回滚**：旧版本附件一直在，出问题让人装回上一个版本即可。

## 发版步骤

设新版本号为 `X.Y.Z`（改动该进次版本还是修订号，见 CHANGELOG 的语义化版本约定）。

```bash
cd <插件目录>

# 1. 改版本号：package.json 的 version
#    （lib/index.js 里的 PKG_VERSION 与 package.json 保持同步；CHANGELOG 加一节）

# 2. 自检 + 打包（会校验语法、组合包声明、脱敏、tarball 内容）
npm run release:check     # 等价于 node scripts/verify.mjs --pack

# 3. 提交
git add -A
git commit -m "release: vX.Y.Z"
git push

# 4. 打标签（干净工作区才能打；等价于 npm run release 的后半段）
git tag -a vX.Y.Z -m "dsh-wallpaper-engine vX.Y.Z"
git push origin vX.Y.Z
```

5. 打开 `https://github.com/Ra-fangtang/dsh-wallpaper-engine/releases/new`
   - Tag：选刚推的 `vX.Y.Z`
   - Title：`dsh-wallpaper-engine vX.Y.Z`
   - 描述：从 `CHANGELOG.md` 对应那一节粘过来
   - **附件**：把 `dist/dsh-wallpaper-engine-X.Y.Z.tgz` 拖进去（发行版的关键就是它）
   - 发布

6. 验证发行版可用（在任意 profile 里，装完记得重启 DSH）：

   ```bash
   dsh plugin --profile web add https://github.com/Ra-fangtang/dsh-wallpaper-engine/releases/download/vX.Y.Z/dsh-wallpaper-engine-X.Y.Z.tgz
   npm run verify --prefix <插件目录>    # 想再确认一次包是完整的
   ```

## 关于 npm registry

如果哪天要发到 npm（国内用户走 `registry.npmmirror.com` 镜像会明显更快）：

```bash
npm login          # 需要 npm 账号；本机当前 ~/.npmrc 里没有 token
npm publish        # 本包的 files 白名单已经把 dist/、scripts/ 挡在外面
```

两个注意点：

- 本机 `~/.npmrc` 的 registry 是 `https://registry.npmmirror.com` —— **镜像只能装不能发**，
  发布必须临时 `npm publish --registry=https://registry.npmjs.org`；
- 发布后想撤，`npm unpublish dsh-wallpaper-engine@X.Y.Z` 有 72 小时限制，慎发。
- 包的 `dsh.engines.dsh` 只是给人看的说明；DSH 真正校验的是 `peerDependencies` 里的
  `@deepseek-ai/dsh` 范围，本插件**刻意不声明**，以免将来 DSH 升级后被判定不兼容而拒绝加载。

## 自检脚本做了什么

`scripts/verify.mjs`：

- `package.json` 的 `files` 白名单里每个路径都存在；
- `lib/index.js`、`assets/wallpaper-client.js` 过 `node --check`；
- 宿主模块能被 `import`，默认导出是 `{ name, apply }` 形状，配置清洗只放行已知字段；
- `dsh.bundle.patch` 指向的文件存在；
- 没有 `dependencies` / `peerDependencies` / `prepare`（刻意的约束，见上）；
- README 与两个源文件里不含本机私有路径（`C:\Users\...`、`D:\Plugins`、`I:\SteamLibrary`）；
- `--pack`：打包并逐项列出 tarball 内容，确认没有混进 `node_modules` / `dist` / `.git`；
- `--tag`：工作区干净时打 `vX.Y.Z` 标签。
