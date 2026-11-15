# 纸条桌宠

两个人使用的桌面纸条，支持 Windows 11 和 Apple 芯片 Mac。一方建立配对，把一次性邀请码发给另一方。收起桌宠后，应用仍在 Mac 菜单栏或 Windows 通知区域运行。

- 双方在线时可以互递文字。对方离线时，发送按钮停用，可以留着草稿，等对方上线后再点发送。
- 「闭关 1 小时」按服务端时间结束，也可选「一直闭关」手动结束。对方在线且在闭关时，纸条会先暂存。
- 对方闭关时可附一句原因申请解除，同时只能有一条待处理请求。闭关方可以直接在提醒中选择结束或继续。
- 出关后会按原顺序补收已经暂存的纸条，桌面只弹一次汇总。已送达的纸条保留 7 天。

应用退出时会尝试立刻标记离线。休眠、关机或网络突然中断时，服务端会在最后一次心跳约 12 秒后标记离线。已经接受的纸条仍会等对方上线和出关。

## 异地使用

两台电脑使用同一个 HTTPS 纸条服务。每套服务只容纳一组配对。服务需要持续运行，并给数据库配置持久存储。Docker 部署示例包含 Caddy，可用已解析到服务器的域名申请 HTTPS 证书。

也可以用 Windows 桌宠右下角的「异地连接」面板管理 Tailscale Serve。两台电脑先安装并登录 Tailscale，Windows 上运行纸条服务，然后在面板填写本地纸条服务端口（默认 8787）和 Tailscale HTTPS 入口端口（默认 443），点「启动 Serve」。如果需要首次授权，在面板的「HTTPS 设置」中启用 HTTPS Certificates。启动成功后，在「管理设备分享」里把 Windows 分享给对方，再点「复制异地邀请码」给她配对。已配对的 Mac 会继续用原来保存的地址，因此日常使用时保持 HTTPS 入口端口一致。

如果要改本地纸条端口，先退出旧的纸条服务，再用新的 PORT 环境变量启动同一个数据库上的服务。随后在面板停用旧路由并按新端口启动 Serve。HTTPS 入口端口保持一致时，已配对的 Mac 可以继续使用原地址。

### 在服务器上运行

1. 将项目放到有 Docker Compose 的服务器，把域名解析到服务器，并开放 80 和 443。
2. 在项目根目录创建 .env。填写 ZHITIAO_DOMAIN（例如 notes.example.com，不带 https://）和 ZHITIAO_SETUP_KEY（随机生成至少 24 个字符，首次创建配对用）。
3. 在目录中运行 docker compose up -d --build。访问 https://你的域名/health，看到 {"ok":true} 就可以配对。
4. 一方在桌宠里点「创建配对」，填昵称、HTTPS 服务地址和设置码。复制邀请码发给对方。另一方在「我有邀请码」里粘贴，就能配对。

纸条和解除原因在发送端加密，服务保存密文、配对昵称、时间及闭关状态。邀请码包含解密所需的共享密钥，请只发给对方。持久卷 notes_data 保存闭关状态和纸条，更新服务时沿用它。

如果平台已经提供 HTTPS 入口，也可以直接部署 Dockerfile。将持久卷挂载到 /state，并配置 ZHITIAO_SETUP_KEY。容器内部监听 8787。

## 本机体验和打包

在项目根目录用 Node.js 24 或更新版本运行以下命令。

~~~sh
npm ci
npm run server
~~~

另开终端运行 npm start。创建配对时填 http://127.0.0.1:8787，设置码留空。用以下命令另启一个客户端可以验证双人收发。

~~~powershell
$env:ZHITIAO_PROFILE = Join-Path (Get-Location) '.cache\second-desktop'
npm start
~~~

~~~sh
ZHITIAO_PROFILE="$PWD/.cache/second-desktop" npm start
~~~

Windows 便携版可以解压后运行 Zhitiao.exe。Apple 芯片 Mac 安装包解压后双击 Install-Zhitiao.command。也可以在终端输入 bash 加一个空格，把安装程序拖到终端，再按回车。安装程序会把应用放到当前用户的 Applications 文件夹。

在 Windows 上运行 npm run build:win 可以从源码生成安装程序。在 Apple 芯片 Mac 上运行 npm run build:mac 生成包含 .app 的 ZIP。输出在 dist。Mac 私用构建使用临时签名，从网络分享后可能需要在目标 Mac 的「隐私与安全性」中允许打开。

运行 npm test 验证配对、离线拦截、闭关暂存、解除请求和过期行为。桌宠图案和拖动交互来自 PetLink，许可证见 THIRD-PARTY-NOTICES.txt。

## 自动更新

从 0.3.0 开始，安装版在启动后和后台定时检查 GitHub Releases。签名通过的新版会自动下载，下次打开桌宠时生效，也可以在「软件更新」里点「重启更新」。配对信息保存在本机应用数据目录里。Mac 从 0.2.0 升到 0.3.0 时，先退出旧桌宠，再运行 0.3.0 的安装程序，它会替换旧应用。

发布同一 Electron 版本的后续桌宠更新：

1. 修改代码并提升 package.json 中的版本号，例如运行 npm version patch --no-git-tag-version。测试后提交源码。
2. 在保有原签名私钥的电脑上运行 npm run update:package。它会在 dist 打出版本对应的 .asar 和 zhitiao-update.json。
3. 在 [GitHub Releases](https://github.com/iicesprite/Zhitiao/releases) 创建并发布对应标签（例如 v0.3.1），把这两个文件作为附件上传。更新仅检查正式发布版本，Git 推送本身不会触发。

初次配置签名时运行 npm run update:key。项目内置桌宠用来验签的公钥，私钥存放在本机 data/update-signing-key.pem，需要单独备份并妥善保管。更换私钥后，老安装包无法验签；升级 Electron 本身时也需要提供新的完整安装包。
