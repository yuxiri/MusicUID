import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getMusicUIDConfig, setMusicUIDConfig } from './MusicUID.js'

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))

const platformOptions = [
  { label: '网易云音乐', value: 'netease' },
  { label: 'QQ 音乐', value: 'qq' },
  { label: '酷狗音乐', value: 'kugou' },
]

const schemas = [
  { label: '基础设置', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'defaultPlatform', label: '默认搜索平台', component: 'Select',
    componentProps: { options: platformOptions },
    bottomHelpMessage: '播放/歌词指令未指定平台时使用。点歌搜索默认仍并发搜索三个平台。',
  },
  {
    field: 'maxList', label: '每个平台显示数量', component: 'InputNumber',
    componentProps: { min: 1, max: 10 },
  },
  {
    field: 'renderScale', label: '图片清晰度倍率', component: 'InputNumber',
    componentProps: { min: 1, max: 3, step: 0.5 },
    bottomHelpMessage: '1× 到 3×。倍率越高图片越清晰，像素尺寸和文件体积也越大。',
  },
  {
    field: 'renderImageType', label: '图片格式', component: 'Select',
    componentProps: { options: [
      { label: 'PNG 无损（更清晰）', value: 'png' },
      { label: 'JPEG（体积较小）', value: 'jpeg' },
    ] },
  },
  {
    field: 'requestTimeout', label: '接口请求超时（毫秒）', component: 'InputNumber',
    componentProps: { min: 1000, max: 120000, step: 1000 },
  },
  { field: 'renderCard', label: '发送图片卡片', component: 'Switch' },
  { field: 'enableResolve', label: '自动解析音乐分享链接', component: 'Switch' },
  {
    field: 'loginWhitelist', label: '凭据管理白名单', component: 'Select',
    componentProps: { mode: 'tags', tokenSeparators: [',', '，', ';', '；'] },
    bottomHelpMessage: '填入可使用登录、Cookie 与音源管理指令的用户 ID；机器人主人始终有权限。',
  },

  { label: '平台凭据', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'neteaseCookie', label: '网易云 Cookie / MUSIC_U', component: 'Input',
    componentProps: { type: 'password', autocomplete: 'new-password' },
    bottomHelpMessage: '填写完整 Cookie 或 MUSIC_U 值。用于网易云登录态取流。',
  },
  {
    field: 'neteaseLevel', label: '网易云优先音质', component: 'Select',
    componentProps: { options: [
      { label: '标准音质', value: 'standard' },
      { label: '极高音质', value: 'exhigh' },
      { label: '无损音质', value: 'lossless' },
    ] },
  },
  {
    field: 'qqCookie', label: 'QQ 音乐 Cookie', component: 'Input',
    componentProps: { type: 'password', autocomplete: 'new-password' },
    bottomHelpMessage: '可选。通常建议使用 QQ 扫码登录；Cookie 作为普通登录态取流备用。',
  },
  {
    field: 'kugouCookie', label: '酷狗 Cookie', component: 'Input',
    componentProps: { type: 'password', autocomplete: 'new-password' },
    bottomHelpMessage: '可选。也可直接使用酷狗扫码登录。',
  },

  { label: '自建音源', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'customApiUrl', label: '自建音源 API 地址', component: 'Input',
    componentProps: { placeholder: '例如 http://127.0.0.1:3300 或 URL 模板' },
  },
  {
    field: 'customApiToken', label: '自建音源 Token', component: 'Input',
    componentProps: { type: 'password', autocomplete: 'new-password' },
  },
  {
    field: 'customApiPriority', label: '音源调用顺序', component: 'Select',
    componentProps: { options: [
      { label: '官方优先，自建兜底', value: 'fallback' },
      { label: '自建优先，官方兜底', value: 'first' },
    ] },
  },

  { label: '音频发送', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'sendVoice', label: '启用音频发送', component: 'Switch',
    bottomHelpMessage: '直接将歌曲源地址交给适配器处理；不在插件内下载或转码。',
  },
  {
    field: 'sendFile', label: '同时发送音频文件', component: 'Switch',
    bottomHelpMessage: '独立于 MP3 语音开关；开启后会在语音之外额外发送文件，默认关闭。',
  },
  {
    field: 'qqBotMp3Voice', label: 'QQBot 发送 MP3 语音', component: 'Switch',
    bottomHelpMessage: '开启后优先请求 MP3 音源，再通过 segment.record 发语音；关闭后优先请求平台默认格式，同样交给适配器处理。MusicUID 不做本地转码，默认开启。',
  },
  {
    field: 'otherMp3Voice', label: '其他适配器发送 MP3 语音', component: 'Switch',
    bottomHelpMessage: '适用于 OneBot 等非 QQBot 适配器。开启后优先请求 MP3 音源，再通过 segment.record 发语音；关闭后优先请求平台默认格式，同样交给适配器处理。MusicUID 不做本地转码，默认开启。',
  },
]

export const supportGuoba = () => {
  return {
    pluginInfo: {
      name: 'musicuid-yunzai',
      title: 'MusicUID',
      description: '网易云音乐、QQ 音乐、酷狗点歌插件',
      author: ['@Xbaiyz12'],
      authorLink: ['https://github.com/Xbaiyz12'],
      link: 'https://github.com/yuxiri/MusicUID',
      isV3: true,
      isV2: false,
      showInMenu: 'auto',
      icon: 'mdi:music',
      iconColor: '#7769d9',
      iconPath: path.join(PLUGIN_ROOT, 'resources', 'images', 'musicuid.svg'),
    },
    configInfo: {
      schemas,
      getConfigData() {
        return getMusicUIDConfig()
      },
      setConfigData(data, { Result }) {
        setMusicUIDConfig(data)
        return Result.ok({}, 'MusicUID 配置已保存并生效。')
      },
    },
  }
}
