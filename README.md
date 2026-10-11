# 河豚终端

河豚产品的授权、版本与交付管理后台，首版 `0.1.0`。紫色品牌、日夜主题、响应式 SaaS 界面，页面直接读写服务端数据。

## 使用流程

1. 在 Linux 服务器安装终端，绑定独立域名。
2. 登录后修改随机生成的初始管理员密码。
3. 创建客户，签发一个 Key，选择主题中心、打包中心、运营中心的授权范围与设备/域名名额。
4. 上传软件更新、客户端源码、主题 ZIP 或成品安装包。文件先进入草稿，确认后发布。
5. 产品按授权接口激活，读取对应目录、检查版本、下载文件。
6. 在线构建提交到队列，由登记的构建执行器领取，回传日志和成品。

**本版交付的是独立终端。** 三个现有产品的客户端接入和真正运行 Flutter/原生 SDK 的构建执行器在后续对接；登记节点本身不会安装编译器，没有执行器的任务保持“等待节点”。测试用产物不代表已经编译出 Android/iOS 安装包。

## Linux 一行安装

以 root 或 sudo 执行，服务器需要能够访问 GitHub 与容器仓库。先确保有 curl：

```bash
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Puffer-zhongduan/main/scripts/install.sh -o /tmp/puffer-install.sh && sudo bash /tmp/puffer-install.sh
```

输入域名、证书邮箱与部署模式即可。支持自动准备 Debian/Ubuntu、RPM 9/10 系列环境；其他 Linux 发行版可先安装 Docker Engine 和 `docker compose` 插件。已有 Docker 会复用，不卸载其他项目。完整条件和共存方法见 [Linux 安装说明](docs/linux-install.md)。

独立模式使用 Caddy 自动申请/续期 HTTPS 证书；宝塔/Nginx 共存模式只暴露本机端口，由已有站点提供 HTTPS。独立模式需要正确 DNS 解析及公网 80/443，不会绕过网络、域名和端口限制。

安装后打开：

```bash
sudo puffer-terminal
sudo puffer-terminal credentials
```

菜单包含安装、状态、日志、更新、备份、恢复、域名修改、密码重置、启动/停止、证书日志、保留数据卸载。初始账号为 `admin`，密码每次全新安装随机生成，首次登录强制修改。

## 本地运行

无 npm 运行依赖。使用外部 Node.js 22+，数据目录必须在项目源码目录之外。

PowerShell：

```powershell
$env:HETUN_TERMINAL_STATE = "$env:LOCALAPPDATA\Programs\UniAppTools\projects\hetun-terminal\state"
node server/index.mjs
```

默认地址 `http://127.0.0.1:8792/`。也可以运行 [本地启动脚本](scripts/start-local.ps1)，在外部目录保存进程号与日志。生产环境必须设置 HTTPS 外部地址；不提供 HTTP 公网登录模式。

## 已实现

| 管理项 | 行为 |
| --- | --- |
| 客户与授权 | 一 Key 授权三产品、续期、停用、Key 轮换，源码下载/本地打包/在线构建权限 |
| 设备与站点 | 桌面产品设备绑定、运营中心域名绑定，名额检查与绑定停用 |
| 授权策略 | 初次联网激活，Ed25519 签名离线凭据，默认 7 天离线与 24 小时复查 |
| 版本中心 | 软件更新/客户端源码/主题/成品四类，平台/架构/渠道，发布与下架，SHA-256 下载校验 |
| 更新检查 | 签名更新清单，语义版本比较，最低支持版本和强制更新标记 |
| 构建任务 | 源码与主题兼容校验，目标选择，客户隔离，排队/日志/取消/产物下载 |
| 构建节点 | 一次性节点令牌，领取/下载/心跳/失败/产物回传，超时及重启中断处理 |
| 维护 | 操作记录、密码变更、外部存储、容器健康检查、升级回退与备份恢复 |

Key 和节点令牌只展示一次，服务端存哈希。签名私钥只保存在运行数据目录；产品最终嵌入终端地址及公钥，不嵌入管理员密码或私钥。联网停用立即阻止后续 API 请求；已经签发的离线凭据到期前无法被服务器远程抹除。离线客户端的签名检查、时钟回拨防护与失败处理必须在后续集成中落实。

## 源码与环境分离

| 用途 | Linux 路径 |
| --- | --- |
| 项目源码 | `/opt/puffer-terminal/releases/<commit>` |
| 部署配置 | `/etc/puffer-terminal` |
| 授权、数据库、密钥、上传文件 | `/var/lib/puffer-terminal/state` |
| 证书运行数据 | `/var/lib/puffer-terminal/caddy` |
| 备份 | `/var/backups/puffer-terminal` |
| 管理命令 | `/usr/local/bin/puffer-terminal` |

仓库内只有项目源码、部署文件、文档和测试。Node/Flutter/Java/Android SDK、证书、管理员密码、上传包和运行数据库都不放在仓库里。

## 验证

```bash
npm run check
HETUN_TEST_ROOT=/tmp/puffer-tests npm test
bash -n scripts/install.sh scripts/linux-menu.sh scripts/verify-linux.sh
shellcheck -x scripts/install.sh scripts/linux-menu.sh scripts/verify-linux.sh
```

GitHub Actions 另在临时 Ubuntu runner 验证 Docker 启动、非 root 运行、Compose 两种部署配置、Caddy 配置、重启持久化、错误域名拒绝、可迁移备份及恢复。证书语法验证不等于真实域名签发。

## 文档与部署边界

- [架构与职责](docs/architecture.md)
- [产品及构建接口](docs/protocol.md)
- [Linux 安装与维护](docs/linux-install.md)

首版为一个管理员、单个服务实例、外部 JSON 原子持久化；不配置多个终端容器共享写入。多管理员、高并发、多服务器部署应升级数据库与任务调度。公网发布依赖实际域名、服务器网络及容器镜像下载条件。Windows、Android、iOS 的原生签名由各自构建执行器完成，本终端核验传输完整性与基本格式，不替代平台签名验证。
