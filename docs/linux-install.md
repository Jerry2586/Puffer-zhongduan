# Linux 安装与迁移

## 一行安装

以 root 或 sudo 执行，先确保有 curl，服务器需要能够访问 GitHub 与容器仓库。

~~~bash
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Puffer-zhongduan/main/install | sudo bash
~~~

安装只询问可选域名和管理员密码。域名留空使用 IP；密码留空生成随机密码。自动选取 20000–59999 的空闲端口并持久保存，更新沿用该端口。IP 访问需要安全组放行显示的 TCP 端口。云服务器请使用实际公网 IP，网卡地址不一定是公网地址。

支持自动准备 Debian/Ubuntu、RPM 9/10 系列环境；其他发行版请先安装 Docker Engine 和 Compose 插件。复用已有 Docker，环境、配置、运行数据与源码分离。

## Linux 管理菜单

~~~bash
sudo hetun
sudo hetun deploy
sudo hetun update
sudo hetun domain
sudo hetun credentials
sudo hetun reset-password
~~~

主菜单：1 安装、2 状态、3 启动、4 停止、5 重启、6 日志、7 绑定域名、8 账号密码、9 检查更新、10 在线更新、11 备份与高级工具、12 HTTPS 诊断、13 卸载、0 退出。顶部显示本机健康检查、安装版本、域名地址与最近备份。
账号子菜单：1 查看初始凭据，2 重置密码。首次改密后初始明文文件被删除，可以使用重置密码设置新密码。密码输入两遍，可自行设置长度，直接回车生成随机密码；确认后短暂停止并重启服务，旧登录会话失效。
备份与高级工具提供备份、恢复、高级域名模式、证书日志、Tunnel 日志和绑定回滚。每次操作完成按回车返回。旧命令 puffer-terminal 保留。

## 域名自动 HTTPS

CF 已把域名解析到当前服务器后，执行 sudo hetun domain，只输入域名。默认不索要 API Token、不修改 DNS、不询问部署模式、服务端口或证书邮箱。

程序自动选择：公网 80/443 空闲时用 Caddy 自动 HTTPS；存在本机标准 Nginx 或宝塔 Nginx 时，为这个域名生成独立站点，使用容器 Certbot 申请证书，配置自动续期并平滑加载。支持 /etc/nginx/conf.d、sites-enabled、宝塔 vhost/nginx 和 /usr/local/nginx/conf/vhost 的标准 include。已存在的单域名 .conf 会备份并接管；多域名共用文件、符号链接、未知代理和手工修改的受管理站点会停止自动处理，保留原网站。

新地址必须通过有效 HTTPS 和本终端公钥一致性检查；仅保存域名或返回 HTTP 200 不算成功。失败恢复原终端配置和修改过的站点。源站必须可被证书验证服务器和 CF 访问，安全组需允许公网 80/443；仅更换应用内部随机端口不能替代公网网站入口。CF 强制 HTTPS、WAF、Access 或源站不可达可能阻断证书验证，此时明确报告失败，不伪造绑定成功。

Nginx 原站点与受管理配置记录位于 /etc/puffer-terminal/domain，证书位于 /var/lib/puffer-terminal/acme，挑战文件目录为 /var/www/puffer-terminal-acme。备份会把证书链接保存为实际文件，恢复仍拒绝包内符号链接。自动续期使用 systemd timer（非 systemd 系统回退 cron），默认每天检查两次。输入 - 清除域名，恢复原站点并切回 IP 直连。保留数据卸载会恢复原站点，sudo hetun start 再接入受管理站点。

已有高级部署与 Cloudflare Tunnel 保留。需要程序修改 CF DNS、创建 Tunnel 时执行 sudo hetun cloudflare-tunnel，才输入具备 Tunnel 编辑、Zone 读取和 DNS 编辑权限的 API Token；令牌不落盘。旧 Tunnel 资源不自动删除。sudo hetun doctor 只读检查公网 HTTPS 和当前终端身份。

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
