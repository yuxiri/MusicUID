# MusicUID · Yunzai V3

本仓库是 [MusicUID 原项目](https://github.com/Xbaiyz12/MusicUID) 的 Yunzai V3 移植版，支持网易云音乐、QQ 音乐和酷狗音乐的搜索、点播、歌词、登录凭据管理与分享链接解析，并提供 Guoba-Plugin 配置面板和图片卡片。

本移植版保留原项目 MIT 许可，见 [LICENSE](./LICENSE)。

## 功能

- 并发搜索网易云、QQ 音乐和酷狗，跨平台连续编号；也可指定单个平台搜索。
- 按搜索结果编号播放歌曲，并获取该歌曲所属平台的歌词。
- 支持网易云、QQ 音乐和酷狗扫码登录，并可手动导入 Cookie。
- 支持「点歌诊断」检查适配器能力、凭据配置状态和平台搜索接口。
- 短时缓存重复搜索结果，并在进程内复用已下载的歌曲封面。
- 管理平台 Cookie、自建音源和凭据管理白名单。
- 解析网易云、QQ 音乐和酷狗的歌曲及歌单链接；网易云还支持专辑链接。
- 使用 Yunzai 图片渲染器生成帮助、搜索结果和状态卡片；图片发送失败时会降为 1× JPEG 重试，仍失败则返回文字结果。
- 可选安装 Guoba-Plugin，在网页配置平台、图片、音频和白名单设置。

## 环境要求

- Yunzai V3
- Node.js 18 或更新版本
- `pnpm`（用于安装插件依赖）
- 使用的 Yunzai 适配器需要支持通过 URL 发送语音。

点播时插件会识别 QQBot、OneBot 等适配器，再按锅巴中的对应开关选择音源格式，直接将地址交给 `segment.record`。不会附带歌名文本，也不会在插件内下载或转码；最终编码由音源和适配器决定。适配器须支持 URL 语音并能访问歌曲源地址；平台也可能限制语音时长，音源地址可能过期。

重复的同平台搜索会短暂复用 30 秒结果；歌曲封面会在进程内缓存 30 分钟，且相同封面只并发下载一次。缓存只保存在内存中，重载插件后清空。

## 安装

在 Yunzai 根目录执行以下命令，将本仓库直接安装到插件目录：

```bash
git clone https://github.com/yuxiri/MusicUID.git ./plugins/MusicUID-Yunzai
cd ./plugins/MusicUID-Yunzai
pnpm install --prod
```

安装后重启或重载 Yunzai。请保留 `index.js`、`MusicUID.js`、`guoba.support.js` 和 `resources/`。首次加载会在 `data/MusicUID/` 创建配置和临时文件目录。

## 指令

所有指令均无需特殊前缀。`N` 表示列表序号。

### 搜索、播放与歌词

| 指令 | 说明 |
| --- | --- |
| `点歌 晴天` | 搜索网易云音乐、QQ 音乐和酷狗音乐，跨平台连续编号 |
| `点歌 QQ 晴天` | 只搜索指定平台；平台可写 `网易云`、`QQ` 或 `酷狗` |
| `播放 晴天` | 搜索默认平台并播放第一首 |
| `听2` | 播放当前会话搜索列表中的第 2 首；列表有效期 10 分钟 |
| `歌词2` | 获取当前列表第 2 首歌曲在对应平台的歌词 |
| `听2` 后发送 `歌词` | 获取最近一次选中歌曲在对应平台的歌词 |
| `歌词 QQ 晴天` | 搜索 QQ 音乐并获取歌词；也支持 `歌词 网易云 晴天`、`歌词 酷狗 晴天` |
| `歌词 晴天` | 使用默认平台查询歌词；未指定时默认网易云 |
| `点歌帮助` | 显示点歌帮助卡片 |

发送网易云、QQ 音乐或酷狗的歌曲/歌单分享链接可解析并播放。歌单会生成可用 `听N` 选播的列表。

### 登录与凭据

| 指令 | 说明 |
| --- | --- |
| `QQ登录` / `点歌登录 QQ` | 使用手机 QQ 扫码登录并更新移动端凭据 |
| `酷狗登录` / `点歌登录 酷狗` | 使用手机酷狗扫码登录 |
| `网易云登录` / `点歌登录 网易云` | 使用网易云音乐 APP 扫码登录并自动保存凭据 |
| `网易云cookie <MUSIC_U>` | 手动导入网易云音乐 Cookie |
| `QQ音乐cookie <Cookie>` | 导入 QQ 音乐 Cookie；无参数时显示获取说明 |
| `酷狗cookie <Cookie>` | 导入酷狗 Cookie；无参数时显示获取说明 |
| `设置cookie <平台> <Cookie>` | 通用导入，平台可写 `qq`、`网易云` 或 `酷狗` |
| `QQ音乐刷新` | 手动刷新已扫码绑定的 QQ 移动端凭据 |
| `点歌状态` | 查看平台凭据、自建音源和 QQ 凭据状态 |
| `点歌诊断` | 以图片卡片检查适配器发送能力、凭据配置概况和三个平台搜索接口；仅主人及白名单可用 |

### 管理与自建音源

| 指令 | 说明 |
| --- | --- |
| `点歌加白 <用户ID/@用户>` | 授权用户使用登录和凭据管理指令，仅主人可操作 |
| `点歌删白 <用户ID/@用户>` | 从凭据管理白名单移除用户，仅主人可操作 |
| `点歌白名单` | 查看已授权用户 |
| `设置自建api <URL>` | 配置自建或第三方音源；输入 `清空` 移除 |
| `自建api模式 fallback` | 官方音源优先，自建音源兜底 |
| `自建api模式 first` | 自建音源优先，官方音源兜底 |
| `测试自建api` | 检查自建音源服务状态 |

凭据管理仅限机器人主人和白名单用户。白名单增删仅限主人。网易云、QQ 音乐和酷狗 Cookie，以及自建 API Token 不会在回复中明文回显。

## Guoba 配置面板

安装并启动 [Guoba-Plugin Next](https://gitee.com/longhengmu/guoba-plugin-next)，重启 Yunzai 后可在 MusicUID 插件配置页调整默认平台、搜索数量、凭据、自建音源、图片清晰度、语音/文件发送开关和登录白名单。配置保存后立即生效。未安装 Guoba-Plugin 不影响指令功能，也可编辑配置文件后重载插件。

## 配置文件

配置路径：`data/MusicUID/config.json`。首次启动会自动创建，默认值如下：

```json
{
  "defaultPlatform": "netease",
  "maxList": 5,
  "requestTimeout": 15000,
  "sendVoice": true,
  "sendFile": false,
  "qqBotMp3Voice": true,
  "otherMp3Voice": true,
  "renderCard": true,
  "renderScale": 2,
  "renderImageType": "png",
  "enableResolve": true,
  "neteaseLevel": "exhigh",
  "customApiUrl": "",
  "customApiToken": "",
  "customApiPriority": "fallback",
  "qqCookie": "",
  "neteaseCookie": "",
  "kugouCookie": "",
  "loginWhitelist": []
}
```

| 配置项 | 说明 |
| --- | --- |
| `defaultPlatform` | 默认平台：`netease`、`qq` 或 `kugou` |
| `maxList` | 每个平台展示歌曲数，范围 1–10 |
| `requestTimeout` | 音乐接口超时时间，单位毫秒 |
| `renderCard` | 是否发送帮助、搜索和状态图片 |
| `renderScale` / `renderImageType` | 图片倍率 1×–3×（步进 0.5）及 PNG/JPEG 格式 |
| `enableResolve` | 是否解析音乐分享链接 |
| `sendVoice` | 是否启用音频发送；默认开启 |
| `sendFile` | 是否在语音之外额外发送音频文件；默认关闭，独立于 MP3 语音开关 |
| `qqBotMp3Voice` | QQBot 是否优先请求 MP3 音源；关闭时优先请求平台默认格式；默认开启 |
| `otherMp3Voice` | 其他适配器（包括 OneBot）是否优先请求 MP3 音源；关闭时优先请求平台默认格式；默认开启 |
| `neteaseLevel` | 网易云登录态优先音质：`standard`、`exhigh` 或 `lossless` |
| `neteaseCookie` | 网易云完整 Cookie 或 `MUSIC_U` 值 |
| `qqCookie` / `kugouCookie` | QQ 音乐或酷狗 Cookie；扫码登录也可用 |
| `loginWhitelist` | 凭据管理白名单用户 ID 列表；机器人主人始终有权限 |
| `customApiUrl` / `customApiToken` | 自建音源地址和访问 Token |
| `customApiPriority` | `fallback` 为官方优先；`first` 为自建优先 |

QQ 扫码凭据单独保存在 `data/MusicUID/qq_credential.json`。不要公开分享 `data/MusicUID/` 中的配置和凭据文件。

## 音频、图片与字体

- 所有语音都通过 `segment.record(URL)` 发送。MusicUID 不执行 SILK 转码；MP3 开关关闭时也只是优先请求平台默认格式，是否转成 SILK 由适配器处理。插件不附加歌名文本。
- 如果语音发送失败，先检查适配器是否支持 URL 语音以及运行适配器的机器能否访问音源。QQBot 等平台仍会执行自身的语音时长限制。
- OneBot 图片发送超时后，插件会将卡片改为 1× JPEG 重试；仍失败时搜索、帮助和状态信息会退回文字。
- 图片使用 Yunzai HTML 渲染器；渲染不可用时退回文字。卡片底部会显示检测到的 Yunzai 本体和版本。
- `resources/MiSansVF.ttf` 为随插件提供的 MiSans 可变字体；字体许可文本见 [`resources/MiSans-License.pdf`](./resources/MiSans-License.pdf)。

## 常见问题

### 指令没有反应

确认插件目录中有 `index.js`，已在插件目录运行 `pnpm install --prod`，并在 Yunzai 重启或重载插件。查看启动日志中的 MusicUID 加载错误。

### 歌曲语音发送失败

确认所用适配器支持 `segment.record(URL)`，并且适配器进程可以访问音源地址。音源格式转换由适配器负责。

### 搜索结果卡片发送超时

插件会自动降清晰度重发；若适配器仍超时，会改发文字列表。也可在锅巴中将倍率调低或切换 JPEG。

### 网易云扫码登录

发送 `网易云登录` 或 `点歌登录 网易云`，使用网易云音乐 APP 扫码并确认。登录成功后插件会自动保存 `MUSIC_U`。如果接口暂时不可用，也可以从已登录的客户端获取 `MUSIC_U`，使用 `网易云cookie <MUSIC_U>` 手动导入。

### 已登录但歌曲无法播放

歌曲是否可播放取决于平台账号权益、音源接口和适配器能力。会员或购买权限受平台校验，插件不能绕过平台版权限制。

## 版权与致谢

- 点歌与平台接口实现移植自 [Xbaiyz12/MusicUID](https://github.com/Xbaiyz12/MusicUID)，按 MIT 许可证分发。
- 图片字体使用 MiSans；相关许可文本随包提供，使用条件请参阅许可文件。
- 状态卡片平台图标采用各平台 App Store 官方应用图标：[网易云音乐](https://apps.apple.com/cn/app/id590338362)、[QQ音乐](https://apps.apple.com/cn/app/id414603431)、[酷狗音乐](https://apps.apple.com/cn/app/id472208016)；相关标识归各平台所有。
- 网易云音乐、QQ 音乐、酷狗音乐名称、歌曲、歌词和封面归各平台及其权利人所有。
