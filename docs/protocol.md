# 河豚终端对接协议 v1

本版提供终端侧 API，三个现有产品后续接入。域名 HTTPS 模式的请求使用 HTTPS；明确启用无域名直连时支持 HTTP IP:端口，管理员 API 仍校验 Origin 与 CSRF；JSON 请求使用 Content-Type: application/json。Key 和构建节点令牌不得放在 URL、Git 或日志中。

## 激活与离线凭据

GET /v1/license/public-key 返回 issuer、algorithm、keyId、publicKey（SPKI PEM）。客户端发布时应内置受信公钥与终端地址；仅从同一未知服务器下载公钥不能建立信任。

POST /v1/license/activate 和 POST /v1/license/check 均提交 Authorization: Bearer <客户Key>，请求体示例：

~~~json
{"product":"packer","deviceId":"desktop-device-0001","version":"0.1.0","nonce":"随机base64url至少16字符","label":"我的打包电脑"}
~~~

product 为 theme-center、packer、operations。前两者提交 deviceId（8–120 个字母、数字、下划线、冒号或横杠）；operations 提交 domain（完整域名，无路径或端口）。nonce 实际必须为 16–100 个 base64url 字符，每次请求随机生成。version 使用三段版本号。返回 activationId、offlineDays 和 lease。

lease 结构：algorithm=Ed25519、keyId、payload、signature。payload 和 signature 均为 base64url；**验签对象是解码后的 payload 原始字节，不能重新序列化 JSON 后验签**。解码后的字段包括 schemaVersion=2、issuer、licenseId、activationId、product、binding、nonce、iat、exp、licenseExpiresAt、checkAfter、permissions。时间为 Unix 秒。

客户端必须验签、匹配受信 issuer/keyId、自身产品及绑定、此次 nonce，并校验签发与到期时间。缓存后离线验证不再匹配新 nonce，而是校验已缓存签名和绑定。在 checkAfter 后尝试联网复查；暂时断网仅可用至 exp。联网得到拒绝需立即停用受限功能。系统时间回拨防护、安全存储由客户端负责。服务端默认每 24 小时复查、最长离线 7 天，可在设置中修改，实际 exp 不超过授权到期时间。

## 更新、目录和成品

激活后的客户请求同时携带 Authorization: Bearer <客户Key> 和 X-Hetun-Activation: <activationId>。

| 方法与路径 | 用途 |
|---|---|
| GET /v1/updates?product=packer&version=0.1.0&platform=windows&arch=x64&channel=stable | 对应产品签名更新清单 |
| POST /v1/installations/report | 上报 version、updateStatus（current/updating/failed）、可选 error |
| GET /v1/catalog | 打包器读取已发布源码、主题、成品目录 |
| GET /v1/releases/:id/download | 下载获准版本，核对 SHA-256 |
| GET /v1/jobs | 当前授权拥有的在线构建任务 |
| POST /v1/jobs | 创建任务 |
| GET /v1/jobs/:id | 当前客户任务状态 |
| GET /v1/jobs/:id/artifact | 已完成任务成品 |

更新清单也是 Ed25519 签名封套，含 updateAvailable、force、release 等字段。platform 为 windows/linux/android/ios/web/all；arch 为 any/x64/arm64；channel 为 stable/beta。软件更新限定对应产品激活；源码/主题/成品需要 packer 激活，源码额外检查 sourceDownload 权限；在线构建检查 cloudBuild 权限。

任务请求：sourceId、themeId、target、name、packageId、version、buildNumber、backend。backend 为无凭据、无查询参数的 HTTPS 运营地址。target 与模板设备兼容关系：android=mobile/tablet/tv，ios=mobile/tablet，windows=desktop/web，web=web。

## 上传包约定

管理员通过界面上传、发布。上传 API 为 POST /api/releases：Content-Type: application/octet-stream；X-Release-Metadata 为 encodeURIComponent(JSON.stringify(metadata))。大小最多 128 MiB。metadata 包含 kind、product、platform、arch、channel、version、name、notes、minVersion、force、engine、filename。

kind=software 对应三个软件产品；client-source/theme/installer 归属 product=client。上传先为 draft，发布后客户可见。版本组合不能重复，撤回后的版本也要用新版本号重新上传。

Flutter 源码 ZIP 根目录必须有 pubspec.yaml 和 lib/main.dart；uni-app 源码根目录必须有 package.json、src/manifest.json、src/pages.json。不要再套外层文件夹。包中不得含 .git、node_modules、.env 或私钥/签名文件。

主题 ZIP 根目录 manifest.json 示例：

~~~json
{"format":"hetun-skeleton","version":3,"renderer":"hetun-flutter-v1","platform":"mobile","id":"puffer-cool","theme":{}}
~~~

支持格式版本 2/3；renderer 为 hetun-v2（uni-app）或 hetun-flutter-v1（Flutter）；platform 为 mobile/tablet/tv/web/desktop。终端检查包协议与兼容性，不负责渲染模板。

## 外部构建节点

管理员登记节点得到一次性 HTW_ 令牌；节点用 Authorization: Bearer <节点令牌>。

| 方法与路径 | 内容 |
|---|---|
| POST /v1/worker/claim | JSON {}；领取最早匹配 target 的任务，无任务返回 job:null |
| GET /v1/worker/jobs/:id/source | 源码归档 |
| GET /v1/worker/jobs/:id/theme | 主题归档 |
| POST /v1/worker/jobs/:id/heartbeat | JSON {log}；心跳和脱敏日志 |
| POST /v1/worker/jobs/:id/fail | JSON {error} |
| POST /v1/worker/jobs/:id/artifact?filename=app.apk | 二进制成品，Content-Type: application/octet-stream，X-Artifact-SHA256 为文件哈希 |

节点只可操作自己领取且仍运行的任务，建议每 30 秒发送心跳。五分钟无心跳任务失败；授权失效、绑定/节点停用和终端重启有相应失败或取消处理。产物允许 android=apk/aab、ios=ipa、windows=exe、web=zip。终端核验扩展名、基础文件头、SHA-256，**不替代平台原生签名校验**。节点需自行安装工具链并在隔离工作目录运行、保存签名凭据和校验产物。

## 状态码

400 参数/包格式无效；401 未登录或凭据缺失；403 权限/授权拒绝；404 资源不存在；409 名额/版本/状态/哈希冲突；413 文件过大；415 内容类型不符。管理员 API 使用会话 Cookie，并要求 Origin 和 X-CSRF-Token；不要复用管理员会话为客户 SDK 鉴权。

## 迁移通知与授权地址下发
GET /v1/terminal-identity、GET /v1/terminal-config、POST /v1/terminal-config/ack 及客户端安全切换约定见 migration.md。activate/check 响应附加 terminalConfig 签名封套；客户端必须实现验签、持久化与受信 issuer 迁移才具备自动换地址能力。
