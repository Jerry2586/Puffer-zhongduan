# 河豚终端

河豚产品的授权、版本与交付管理后台，版本 `0.2.3`。紫色品牌、日夜主题、响应式 SaaS 界面，页面直接读写服务端数据。

## 使用流程

1. 在 Linux 服务器一键 Docker 部署，域名可选；留空使用 IP 加端口。
2. 安装时设置管理员密码；留空则生成随机密码，首次登录后修改。
3. 创建客户，签发一个 Key，选择主题中心、打包器、影视中心〔APP 后台〕的授权范围与设备/域名名额。
4. 分别管理三个产品的更新包、产品源码与安装包；APP 源码和主题模板有独立入口。文件先进入草稿，确认后发布。
5. 产品按授权接口激活，读取对应目录、检查版本、下载文件。
6. 在线构建提交到队列，由登记的构建执行器领取，回传日志和成品。

**本版交付的是独立终端。** 三个现有产品的客户端接入和真正运行 Flutter/原生 SDK 的构建执行器在后续对接；登记节点本身不会安装编译器，没有执行器的任务保持“等待节点”。测试用产物不代表已经编译出 Android/iOS 安装包。

新增接口及后续产品接入要求见 [产品版本与授权协议](docs/product-center.md)。静默本地租约仍遵守授权到期时间；恢复在线策略由产品下一次成功连接时获取。终端能签发和管理策略，三个产品的本地执行与自动安装需后续接入。

## Linux 一行安装

以 root 或 sudo 执行，服务器需要能够访问 GitHub 与容器仓库。先确保有 curl：

```bash
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Puffer-zhongduan/main/install | sudo bash
```

首次只询问可选域名和管理员密码。域名留空使用 IP 和自动空闲端口；CF 已解析到服务器后，只输入域名即可自动接入：80/443 空闲时启用 Caddy HTTPS，已有本机 Nginx/宝塔时自动管理该域名的独立站点、申请与续期证书。默认不索要 CF 令牌、不修改 CF DNS；只有公网 HTTPS 与本终端签名身份核验通过才报告成功，失败恢复原配置。其他站点和手工改动受到保护。未知入口、共享域名配置或网络阻断会明确报错。需要 Tunnel 时可单独执行 `sudo hetun cloudflare-tunnel`，该高级模式才询问 CF API Token。

安装后：

```bash
sudo hetun
sudo hetun update
sudo hetun credentials
```

主菜单显示运行状态、安装版本、访问地址与最近备份，提供安装、状态、启停、日志、域名、账号、Git 检查、在线更新、HTTPS 诊断和卸载。备份恢复与高级部署收纳在子菜单。绑定域名使用无端口 HTTPS；不再提供域名加端口作为新绑定模式。旧直连配置明确显示为临时访问，执行 sudo hetun domain 可迁移。sudo hetun doctor 核验公网证书与本机终端身份，并提示 Cloudflare 525 等错误。初始账号为 `admin`，自定义密码可直接登录；随机密码首次登录需要修改。完整条件见 [Linux 安装说明](docs/linux-install.md)。

## 本地运行

无 npm 运行依赖。使用外部 Node.js 22+，数据目录必须在项目源码目录之外。

PowerShell：

```powershell
$env:HETUN_TERMINAL_STATE = "$env:LOCALAPPDATA\Programs\UniAppTools\projects\hetun-terminal\state"
node server/index.mjs
```

默认地址 `http://127.0.0.1:8792/`。也可以运行 [本地启动脚本](scripts/start-local.ps1)，在外部目录保存进程号与日志。无域名直连需显式启用 `HETUN_TERMINAL_DIRECT_HTTP=true`，Linux 菜单自动配置。HTTP 直连不加密网络传输；绑定域名后可切换 HTTPS。

## 已实现

| 管理项 | 行为 |
| --- | --- |
| 客户与授权 | 一 Key 授权三产品、续期、停用、Key 轮换，源码下载/本地打包/在线构建权限 |
| 设备与站点 | 桌面产品设备绑定、运营中心域名绑定，名额检查与绑定停用 |
| 授权策略 | 全局及单独授权的在线 / 静默本地策略，域名范围、策略版本、待同步统计；Ed25519 签名租约 |
| 版本中心 | 打包器、主题中心、影视中心独立入口；产品源码、APP 源码、主题模板与成品分类，安装/升级/兼容说明与发布历史 |
| Git 来源 | 分产品绑定 GitHub 公共仓库、检查提交及 Release 附件；完整性校验后导入草稿，发布仍需管理员操作 |
| 云端记录 | 接收主题导出、模板安装、本地打包与更新结果的元数据，身份校验、重试去重、客户筛选与分页 |
| 更新检查 | 签名更新清单，语义版本比较，最低支持版本和强制更新标记 |
| 构建任务 | 源码与主题兼容校验，目标选择，客户隔离，排队/日志/取消/产物下载 |
| 构建节点 | 一次性节点令牌，领取/下载/心跳/失败/产物回传，超时及重启中断处理 |
| 产品对接 | 三产品协议、公钥与配置下载，真实设备绑定、联网时间与已发布版本统计 |
| 部署与迁移 | 加密导出、迁移预览、空目标导入，保留签名身份与版本文件 |
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

GitHub Actions 另在临时 Ubuntu runner 验证 Docker 启动、非 root 运行、Compose 三种部署配置、Caddy 配置、重启持久化、错误域名拒绝、可迁移备份及恢复。证书语法验证不等于真实域名签发。

## 文档与部署边界

- [架构与职责](docs/architecture.md)
- [产品及构建接口](docs/protocol.md)
- [Linux 安装与维护](docs/linux-install.md)

首版为一个管理员、单个服务实例、外部 JSON 原子持久化；不配置多个终端容器共享写入。多管理员、高并发、多服务器部署应升级数据库与任务调度。公网访问依赖服务器网络、安全组以及容器镜像下载条件；域名仅在使用域名访问时需要。Windows、Android、iOS 的原生签名由各自构建执行器完成，本终端核验传输完整性与基本格式，不替代平台签名验证。

### 终端自身更新

终端设置的“版本与更新”检查固定仓库 Jerry2586/Puffer-zhongduan 的 main 提交。Linux 安装后支持在线更新，自动备份、重新构建并健康检查；失败尝试回退。在线更新由宿主机 systemd 定时服务执行，网页不持有 Docker socket。没有 systemd 时仍可用 sudo hetun update。Windows 本地开发预览支持检查 Git，在线安装按钮保持禁用。

Linux 更多管理新增“在线更新”；“卸载管理”可选择保留数据或删除终端数据与源码，两种方式都保留备份，Docker 与其他站点不会删除。完整卸载需两次文字确认。卸载后停止更新代理；保留数据时 sudo hetun start 恢复。更新记录在 /var/lib/puffer-terminal/maintenance/update.log，代理日志使用 journalctl -u puffer-terminal-update.service。

迁移与签名授权地址管理：见 docs/migration.md。部署与迁移页支持维护开关、整包加密导出/导入、正式与备用地址身份验证和真实客户端回执记录。新版整包上限 8 GiB，三个产品的客户端接入另行实施。
