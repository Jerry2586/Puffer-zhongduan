# Linux 安装与迁移

## 一行安装

以 root 或 sudo 执行，先确保有 curl，服务器需要能够访问 GitHub 与容器仓库。

~~~bash
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Puffer-zhongduan/main/install | sudo bash
~~~

安装只询问可选域名和管理员密码。域名留空使用 IP；密码留空生成随机密码。自动选取 20000–59999 的空闲端口并持久保存，更新沿用该端口。IP 访问需要安全组放行显示的 TCP 端口。云服务器请使用实际公网 IP，网卡地址不一定是公网地址。

支持自动准备 Debian/Ubuntu、RPM 9/10 系列环境；其他发行版请先安装 Docker Engine 和 Compose 插件。复用已有 Docker，环境、配置、运行数据与源码分离。

## 四项管理菜单

~~~bash
sudo hetun
sudo hetun deploy
sudo hetun update
sudo hetun domain
sudo hetun credentials
sudo hetun reset-password
~~~

主菜单：1 安装/更新，2 绑定/修改域名，3 账号/密码，4 更多管理，0 退出。
账号子菜单：1 查看初始凭据，2 重置密码。首次改密后初始明文文件被删除，可以使用重置密码设置新密码。密码输入两遍，可自行设置长度，直接回车生成随机密码；确认后短暂停止并重启服务，旧登录会话失效。
更多管理提供状态、日志、重启、备份、恢复、检查更新、启停、卸载、高级域名模式、证书日志、Tunnel 日志和绑定回滚。每次操作完成按回车返回。旧命令 puffer-terminal 保留。

## 域名自动 HTTPS

默认使用 Cloudflare Tunnel，不占用服务器 80/443，不需要改已有网站。域名必须在 Cloudflare 的活动 DNS 区域中。输入域名后，工具读取一次 API Token，创建 Tunnel 和指定域名 DNS，并等待公网 HTTPS 返回本终端的公钥与身份。只有身份验证通过才报告绑定成功；失败回滚本地配置和本次远端变更。

API Token 需要目标账号的 Cloudflare Tunnel 编辑、目标区域的 Zone 读取和 DNS 编辑权限。工具只修改输入域名的 A/AAAA/CNAME，绑定将替换这些记录。令牌不写入磁盘和日志。Tunnel 的运行连接令牌仍须私密保存，位于外部 state/deployment 目录。服务器需要访问 Cloudflare API，并允许 Tunnel 出站连接（7844 TCP/UDP，HTTPS 443）。只输入域名无法绕过域名管理权限和网络条件。

公网验证是绑定时的检查结果，页面展示检查时间，不代表持续在线监控。成功更换域名时旧 Tunnel 资源不会自动删除，可在 Cloudflare 核对后自行清理。输入 - 可以清除当前域名，切回 IP 直连；远端旧资源保留。

高级部署通过更多管理或 sudo hetun advanced-domain 进入：独立 Caddy 自动 HTTPS 要求正确 DNS、公网 80/443 可用；已有宝塔/Nginx 共存模式由现有站点提供证书和代理；域名加端口直连为 HTTP。代理应保留 Host，上传上限至少 128m，外部域名/协议须与终端配置一致。HTTP 直连不加密网络传输。

## 产品对接与页面迁移

产品对接页提供授权地址、公钥、协议和配置下载，统计来自实际绑定记录、最近联网时间及已发布的软件版本。当前只交付终端侧接口，三个客户端尚未接入时不会显示已对接。

部署与迁移页可以导出加密 .hetun 包：确认当前管理员密码，设置独立迁移口令。包包含客户、授权、绑定、版本、文件、管理员密码哈希和签名密钥。迁移口令不保存在终端，需自行妥善保管。

新服务器安装后登录，选择导入迁移包并填写口令。先预览数量与签名身份，确认后导入。目标必须没有客户、授权、绑定、版本、构建任务或节点等业务记录；导入会替换目标管理员和签名身份，完成后使用原服务器账号重新登录。排队和执行中的构建任务转为取消，历史产物保留。旧离线凭据的签名身份保持有效。

页面迁移最多包含 64 MB 引用文件，超限请使用 Linux 完整备份方式。迁移包不携带服务器域名、端口或 Cloudflare 令牌，新服务器需重新绑定域名。迁移操作没有自动切换 DNS，正式切换前应验证新服务器。

## 文件分离与完整备份

| 路径 | 内容 |
|---|---|
| /opt/puffer-terminal/releases/<commit> | 版本源码 |
| /etc/puffer-terminal | root 私有部署配置 |
| /var/lib/puffer-terminal/state | 业务数据、密码哈希、密钥、版本文件及 Tunnel 连接令牌 |
| /var/lib/puffer-terminal/caddy | 高级独立模式证书 |
| /var/backups/puffer-terminal | 完整备份和 SHA-256 |
| /usr/local/bin/hetun | 管理菜单入口 |

~~~bash
sudo hetun backup
sudo hetun restore
sudo env HETUN_REF=<完整提交SHA或标签> hetun update
~~~

更新拉取 main 的具体提交，先备份再构建启动，启动失败回退程序和配置。备份短暂停止本项目确保数据一致。恢复需要备份绝对路径及 RESTORE，恢复前另做备份并保留旧目录。完整 Linux 备份包含部署配置和令牌，跨服务器恢复后须重新核对并绑定域名、端口，不要同时运行相同 Tunnel 或泄露备份。

卸载输入 UNINSTALL，移除本项目容器并保留源码、状态及备份，不删除 Docker。可以使用 sudo hetun start 重新启动。

## 验证范围

CI 在临时 Ubuntu 环境验证容器构建、非 root 用户、健康检查、重启身份持久化、备份恢复和高级 Caddy 配置。自动化用独立临时状态验证加密迁移与 Cloudflare 错误回滚；真实域名授权、Tunnel 公网连接和各发行版环境安装仍需对应服务器现场验证。
