# Linux 安装与维护

## 一行启动

~~~bash
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Puffer-zhongduan/main/install | sudo bash
~~~

同一入口首次运行部署，已有安装时更新。域名可以留空，直接回车进入 IP 加端口模式，再确认自动推荐的空闲端口。填写域名后选择自动 HTTPS、已有代理共存或域名加端口直连；只有自动 HTTPS 询问证书邮箱。管道入口从 `/dev/tty` 读取选择，SSH 中可以正常交互。需要 root/sudo、curl、tar，以及到 GitHub、Docker 软件源和容器仓库的网络。自动准备 Docker 支持 Debian/Ubuntu 和使用 dnf/systemd 的 RPM 9/10 系列；其他发行版先准备 Docker Engine、Compose v2、curl、tar、ss。已有 Docker 会复用；缺少 Compose 或 Docker 未运行会明确提示处理。

安装独立 Compose 项目 puffer-terminal，不删除或停止其他服务。默认从 8792–8892 推荐第一个空闲端口；发现 80/443 占用时推荐共存模式。手动指定的端口若被占用会拒绝安装。没有承诺所有发行版、网络、代理、SELinux 或端口条件都自动适配。

## 域名可选与访问方式

**无域名直连**：域名留空，终端监听 `0.0.0.0:<空闲端口>`，使用 `http://服务器公网IP:端口`。不需要邮箱、DNS 或 80/443。服务器安全组须放行所选 TCP 端口；菜单显示的是服务器网卡地址，NAT/云服务器应使用实际公网 IP。HTTP 不加密传输，之后可以在菜单绑定域名切换 HTTPS。管理员请求仍校验同源 Origin 与 CSRF，无域名模式只接受 IP/localhost 主机名，签名凭据、更新清单及下载地址使用实际访问来源。

**域名加端口直连**：填写域名选择模式 3，使用 `http://域名:端口`，无需申请证书。

## 域名与证书

**独立模式**：绑定域名，Caddy 自动申请和续期证书。域名 A/AAAA 应正确解析到服务器，公网 80/TCP、443/TCP 能到达此服务器，且未被其他服务占用。443/UDP 用于 HTTP/3。配置验证通过不表示公网证书已签发，查看证书日志确认。

**共存模式**：已有宝塔/Nginx/代理继续负责域名证书，终端仅监听 127.0.0.1:8792（可改）。反向代理到该地址，保留 Host，请求上传上限至少 128m。HTTPS 外部地址须与安装时域名一致。推荐新子域名，无须放到苹果 CMS 的网站目录。

## 进入菜单

~~~bash
sudo hetun
~~~

菜单顶部显示安装版本、提交、容器状态及访问地址。菜单包含安装、状态与地址、日志、更新、检查更新、重启、备份、恢复、修改域名/模式、初始账号、重置密码、启动、停止、证书日志、卸载。旧命令 `puffer-terminal` 保留。修改域名时输入 `-` 可清除域名并切回 IP 直连。

`sudo hetun deploy`：未安装则部署，已安装则更新；`sudo hetun update`：拉取仓库版本、备份、构建 Docker 容器并重启，启动失败回退。这些短命令调用 Docker Compose，无需手动输入 Compose 文件路径。首次入口 URL 使用真实 GitHub 地址；尚未配置短域名，不提供虚构的短网址。

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
