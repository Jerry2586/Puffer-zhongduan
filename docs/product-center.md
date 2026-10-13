# 产品版本与授权协议

## 产品和资源

| 标识 | 用途 | 文件分类 |
| --- | --- | --- |
| packer | 河豚打包器 | software 更新包、product-source 产品源码 ZIP、installer 安装包 |
| theme-center | 河豚主题中心 | 同上 |
| operations | 河豚影视中心〔APP 后台〕 | 同上 |
| client | APP 资源 | client-source Flutter/uni-app 源码 ZIP、installer 成品 |
| templates | 模板资源入口 | theme ZIP（文件 product 仍为 client） |

每份版本提供版本号、平台、架构、渠道、更新说明、安装说明、升级说明、兼容要求、SHA-256 和来源。上传或 Git 导入默认进入 draft，管理员发布为 published 后才供产品查询。withdrawn 停止分发。产品源码不作为可直接自动安装的软件更新。

## 授权策略

管理员 PATCH /api/authorization-policy 设置 authorizationMode（online 或 silent-local）和 reconnectHours（1–168）。PATCH /api/licenses/{id} 设置 authorizationMode（null 跟随全局）及 domains（最多20个域名），权限仍为 sourceDownload/localBuild/cloudBuild。绑定计数与域名校验继续生效。

激活 /v1/license/activate 和检查 /v1/license/check 返回 schemaVersion 3 的 Ed25519 签名租约，包含授权/客户/产品/设备身份、domain、authorizedDomains、authorizationMode、policyRevision、checkAfter、exp、permissions。客户端须校验公钥签名、issuer、nonce、本地绑定身份和期限。

online 租约遵守普通离线宽限；silent-local 租约延长至授权到期时间，同时保留低频重连时间。策略不能隔空发送到断网设备：下次成功认证后获取最新策略，同一身份不重复占用名额。永久离线产品无法被远程撤销；客户端的签名校验、重连、记录补传及本地防复制尚待三个产品接入实现。

## Git 与发布

PATCH /api/repositories/{resource} 接收 repository（GitHub owner/repo 或仓库URL）和 branch；空 repository 解除绑定。POST 同路径 /check 检查公开仓库提交和最多10份 Release。提交变化不等于可安装软件更新。

POST /api/repositories/{resource}/import 接收 assetId 与 metadata，必须为最近30分钟内检查到的附件。附件限制128MB，检查长度和 GitHub 提供的 SHA-256；仅允许 GitHub 附件域名重定向。导入经过普通包格式校验后成为草稿。当前支持公开仓库，不存储 GitHub 私有仓库令牌。

终端自身继续使用 /api/self-update、/check、/install；Linux 维护服务在线时可请求更新，本地 Windows 预览只提供检查。

## 产品资源接口

使用 Authorization: Bearer <客户Key> 和 X-Hetun-Activation: <激活ID>。

- GET /v1/product-catalog：当前激活产品的已发布更新/安装包及获准的产品源码，签名返回。
- GET /v1/templates：打包器或主题中心读取已发布模板目录，签名返回。
- GET /v1/catalog：打包器读取 APP 源码和模板，源码受 sourceDownload 权限限制。
- GET /v1/updates：当前激活产品的语义版本更新清单。
- GET /v1/releases/{id}/download：校验授权和归属后下载，禁止跨产品源码访问。

## 云端记录

POST /v1/records 请求示例：

~~~json
{"eventId":"build-event-000001","type":"local-build","version":"1.0.0","occurredAt":"2026-10-13T00:00:00.000Z","details":{"name":"河豚影视","platform":"android","result":"success"}}
~~~

事件允许：主题中心 theme-export/template-install，打包器 local-build/source-download/theme-install，三个产品均可 update-check/update-success/update-failed。eventId 由客户端持久生成，16–100位字母数字或 _-；重试使用同一ID和内容。重复返回200，首次201，内容冲突409。不同授权记录相互隔离，本地打包/源码下载事件检查对应权限。

details 仅接受 name/themeId/sourceId/releaseId/platform/result/message/sha256 简短字符串，不接收源码内容、Key 或私钥。只提供服务端接口，当前三个产品不会自动上报。GET /v1/records 返回本授权最近100条；管理员 GET /api/product-records 支持 licenseId/product/offset，每页100条。总容量50000条，满后明确拒绝新增。

版本历史保留最近10000条，页面显示最近500条。记录和策略随加密迁移包导出，导入保留签名身份。
