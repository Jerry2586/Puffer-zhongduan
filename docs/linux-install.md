# Linux 安装与维护

## 一行启动

~~~bash
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Puffer-zhongduan/main/scripts/install.sh -o /tmp/puffer-install.sh && sudo bash /tmp/puffer-install.sh
~~~

脚本下载源码并打开安装步骤；依次输入域名、证书邮箱、模式和本机端口。需要 root/sudo、curl、tar，以及到 GitHub、Docker 软件源和容器仓库的网络。自动准备 Docker 支持 Debian/Ubuntu 和使用 dnf/systemd 的 RPM 9/10 系列；其他发行版先准备 Docker Engine、Compose v2、curl、tar、ss。已有 Docker 会复用；缺少 Compose 或 Docker 未运行会明确提示处理。

安装独立 Compose 项目 puffer-terminal，不删除或停止其他服务。端口检查发现占用会拒绝，需选择共存模式或换本机端口。没有承诺所有发行版、网络、代理、SELinux 或端口条件都自动适配。

## 域名与证书

**独立模式**：绑定域名，Caddy 自动申请和续期证书。域名 A/AAAA 应正确解析到服务器，公网 80/TCP、443/TCP 能到达此服务器，且未被其他服务占用。443/UDP 用于 HTTP/3。配置验证通过不表示公网证书已签发，查看证书日志确认。

**共存模式**：已有宝塔/Nginx/代理继续负责域名证书，终端仅监听 127.0.0.1:8792（可改）。反向代理到该地址，保留 Host，请求上传上限至少 128m。HTTPS 外部地址须与安装时域名一致。推荐新子域名，无须放到苹果 CMS 的网站目录。

## 进入菜单

~~~bash
sudo puffer-terminal
~~~

菜单包含安装、状态与地址、日志、更新、备份、恢复、修改域名/模式、初始账号、重置密码、启动、停止、证书日志、卸载。

~~~bash
sudo puffer-terminal credentials
sudo puffer-terminal status
sudo puffer-terminal update
sudo puffer-terminal backup
sudo puffer-terminal restore
sudo puffer-terminal domain
sudo puffer-terminal reset-password
~~~

首次账号 admin，随机密码通过 credentials 查看。登录必须修改；修改后初始明文文件删除。重置需要输入 RESET 并短暂停止终端。不要把密码或私钥上传到仓库。

## 文件分离

| 路径 | 内容 |
|---|---|
| /opt/puffer-terminal/releases/<commit> | 只读版本源码 |
| /etc/puffer-terminal | 部署配置，root 私有 |
| /var/lib/puffer-terminal/state | 授权、密码哈希、签名密钥、版本文件 |
| /var/lib/puffer-terminal/caddy | 自动证书持久化 |
| /var/backups/puffer-terminal | 完整备份和 SHA-256 |
| /usr/local/bin/puffer-terminal | 管理菜单 |

更新拉取 main 的具体提交，备份后构建再启动。启动失败回退之前程序和配置；数据迁移不兼容时需要用备份恢复。备份短暂停止本项目，确保 JSON、文件和密钥一致，然后恢复运行。恢复要输入备份绝对路径以及 RESTORE；恢复前另外备份，并保留旧配置/数据目录。

~~~bash
sudo env HETUN_REF=<完整提交SHA或标签> puffer-terminal update
~~~

卸载输入 UNINSTALL：移除本项目容器，保留源代码、状态和备份，也不删除 Docker。以后用 sudo puffer-terminal start 重新启动。

## 故障排查

先看 status、logs 和证书日志。安装未健康启动时保留配置，可用 start 重试；证书失败检查 DNS、A/AAAA、安全组和 80/443 连通性。反向代理 403 检查外部域名、Host 和 HTTPS 配置。备份恢复失败时旧目录保存在 .pre-restore.*；不要删除密钥，否则历史离线签名无法继续验证。

CI 验收使用临时 Ubuntu runner，测试容器构建、非 root 用户、健康检查、重启保留密钥、备份/移动备份/恢复，以及 Caddy 配置。公网证书和 RPM 发行版自动环境安装需在实际服务器再验收。
