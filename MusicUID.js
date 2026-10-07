import plugin from '../../lib/plugins/plugin.js'
import { createCipheriv, createHash, randomInt, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import QRCode from 'qrcode'

const DATA_DIR = path.join(process.cwd(), 'data', 'MusicUID')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const CREDENTIAL_FILE = path.join(DATA_DIR, 'qq_credential.json')
const TEMP_DIR = path.join(DATA_DIR, 'temp')
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const FONT_FILE = path.join(PLUGIN_DIR, 'resources', 'MiSansVF.ttf')
const PLUGIN_NAME = path.basename(PLUGIN_DIR)
const KUGOU_QR_APPID = 1014
const KUGOU_MUSIC_APPID = 1005
const DEFAULT_CONFIG = {
  defaultPlatform: 'netease',
  maxList: 5,
  requestTimeout: 15000,
  sendVoice: true,
  sendFile: false,
  qqBotMp3Voice: true,
  otherMp3Voice: true,
  renderCard: true,
  renderScale: 2,
  renderImageType: 'png',
  enableResolve: true,
  neteaseLevel: 'exhigh',
  customApiUrl: '',
  customApiToken: '',
  customApiPriority: 'fallback', // fallback | first
  qqCookie: '',
  neteaseCookie: '',
  kugouCookie: '',
  loginWhitelist: [],
}

const PLATFORMS = {
  netease: { name: '网易云音乐', aliases: ['网易', '网易云', '网易云音乐', 'netease', 'ncm', 'wyy'] },
  qq: { name: 'QQ音乐', aliases: ['qq', 'qq音乐', '扣扣音乐', 'qqmusic'] },
  kugou: { name: '酷狗音乐', aliases: ['酷狗', '酷狗音乐', 'kugou', 'kg'] },
}
const SEARCH_ORDER = ['netease', 'qq', 'kugou']
const sessions = new Map()
const searchCache = new Map()
const searchInFlight = new Map()
const coverCache = new Map()
const coverInFlight = new Map()
const SEARCH_CACHE_TTL = 30 * 1000
const SEARCH_CACHE_MAX = 120
const COVER_CACHE_TTL = 30 * 60 * 1000
const COVER_CACHE_NEGATIVE_TTL = 60 * 1000
const COVER_CACHE_MAX = 100
const COVER_CACHE_MAX_BYTES = 300 * 1024
const loginTasks = global.__MusicUIDLoginTasks || (global.__MusicUIDLoginTasks = new Map())
const SESSION_TTL = 10 * 60 * 1000

for (const task of loginTasks.values()) task.cancelled = true
loginTasks.clear()

function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const migrated = { ...saved }
    const aliases = {
      default_platform: 'defaultPlatform', max_list: 'maxList', request_timeout: 'requestTimeout',
      render_card: 'renderCard', send_voice: 'sendVoice', send_file: 'sendFile',
      enable_resolve: 'enableResolve',
      netease_level: 'neteaseLevel', netease_cookie: 'neteaseCookie', qqmusic_cookie: 'qqCookie',
      kugou_cookie: 'kugouCookie', login_whitelist: 'loginWhitelist', custom_api_url: 'customApiUrl',
      custom_api_token: 'customApiToken', custom_api_priority: 'customApiPriority',
    }
    for (const [oldKey, newKey] of Object.entries(aliases)) {
      if (migrated[newKey] === undefined && migrated[oldKey] !== undefined) migrated[newKey] = migrated[oldKey]
      delete migrated[oldKey]
    }
    if (migrated.customApiPriority === 'custom_first') migrated.customApiPriority = 'first'
    if (migrated.customApiPriority === 'fallback_only') migrated.customApiPriority = 'fallback'
    const obsoleteKeys = [
      'voiceFormat', 'voiceFormatRevision', 'localFileRef', 'downloadTimeout',
      'voiceMaxMB', 'voiceBitrate', 'keepTempSec', 'voice_format', 'local_file_ref',
      'download_timeout', 'voice_max_mb', 'voice_bitrate', 'keep_temp_sec',
      'qqBotSendMp3', 'otherSendMp3',
    ]
    const hadObsoleteKeys = obsoleteKeys.some(key => Object.hasOwn(migrated, key))
    for (const key of obsoleteKeys) delete migrated[key]
    if (hadObsoleteKeys) {
      fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ ...DEFAULT_CONFIG, ...migrated }, null, 2)}\n`, 'utf8')
    }
    return { ...DEFAULT_CONFIG, ...migrated }
  } catch (err) {
    if (err.code === 'ENOENT') {
      const initial = { ...DEFAULT_CONFIG }
      fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(initial, null, 2)}\n`, 'utf8')
      return initial
    } else {
      logger.warn(`[MusicUID] 配置文件读取失败，暂用默认配置且不会覆盖原文件：${err.message}`)
    }
    return { ...DEFAULT_CONFIG }
  }
}

let config = loadConfig()

function saveConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export const getMusicUIDConfig = () => {
  return {
    ...config,
    loginWhitelist: Array.isArray(config.loginWhitelist) ? [...config.loginWhitelist] : [],
  }
}

export const setMusicUIDConfig = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('配置数据格式无效')
  const next = { ...config }
  const booleans = ['sendVoice', 'sendFile', 'qqBotMp3Voice', 'otherMp3Voice', 'renderCard', 'enableResolve']
  const strings = ['customApiUrl', 'customApiToken', 'qqCookie', 'neteaseCookie', 'kugouCookie']
  const numbers = {
    maxList: [1, 10], requestTimeout: [1000, 120000], renderScale: [1, 3],
  }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!Object.hasOwn(input, key)) continue
    const value = input[key]
    if (booleans.includes(key)) {
      next[key] = value === true || value === 1 || value === 'true' || value === '1'
    } else if (strings.includes(key)) {
      next[key] = String(value ?? '').trim()
    } else if (numbers[key]) {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new TypeError(`${key} 必须是数字`)
      const [min, max] = numbers[key]
      const normalized = key === 'renderScale' ? Math.round(parsed * 2) / 2 : Math.round(parsed)
      next[key] = Math.min(max, Math.max(min, normalized))
    } else if (key === 'defaultPlatform') {
      if (!Object.hasOwn(PLATFORMS, value)) throw new TypeError('默认平台必须为 netease、qq 或 kugou')
      next[key] = value
    } else if (key === 'neteaseLevel') {
      if (!['standard', 'exhigh', 'lossless'].includes(value)) throw new TypeError('网易云音质配置无效')
      next[key] = value
    } else if (key === 'renderImageType') {
      if (!['png', 'jpeg'].includes(value)) throw new TypeError('图片格式必须为 png 或 jpeg')
      next[key] = value
    } else if (key === 'customApiPriority') {
      if (!['fallback', 'first'].includes(value)) throw new TypeError('自建音源优先级配置无效')
      next[key] = value
    } else if (key === 'loginWhitelist') {
      const ids = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;，；]+/)
      next[key] = [...new Set(ids.map(item => String(item).trim()).filter(Boolean))]
    }
  }
  config = next
  saveConfig()
  return getMusicUIDConfig()
}

function cleanText(value) {
  return String(value ?? '').trim()
}

function audioAdapterKind(e) {
  const adapter = e?.adapter && typeof e.adapter === 'object' ? e.adapter : {}
  const identifiers = [e?.adapter_id, adapter.id, adapter.name, e?.bot?.adapter_id, e?.bot_id, e?.platform]
    .map(value => cleanText(value).toLowerCase()).filter(Boolean)
  if (identifiers.includes('qq_official') || identifiers.some(value => /qqbot|qq-official/.test(value))
    || identifiers.some(value => ['qq-private', 'qq-group'].includes(value))) return 'qqbot'
  if (identifiers.some(value => /onebot|ob11/.test(value))) return 'onebot'
  return 'generic'
}

function isQQBotVoiceAdapter(e) {
  return audioAdapterKind(e) === 'qqbot'
}

function audioDeliveryProfile(e) {
  const kind = audioAdapterKind(e)
  const adapter = kind === 'qqbot' ? 'QQBot' : kind === 'onebot' ? 'OneBot' : cleanText(e?.adapter_id || e?.platform) || '通用适配器'
  return {
    kind, adapter,
    preferMp3: kind === 'qqbot' ? config.qqBotMp3Voice : config.otherMp3Voice,
    canSendVoice: typeof global.segment?.record === 'function',
    canSendFile: typeof global.segment?.file === 'function',
  }
}

function textOf(e) {
  const basic = cleanText(e.msg || e.raw_message || e.rawMessage)
  if (!Array.isArray(e.message)) return basic.replace(/^[#＃/!！]+\s*/, '')
  const segments = e.message.map(item => {
    if (typeof item === 'string') return item
    if (item?.type === 'text') return item.text || ''
    if (item?.type === 'json' || item?.type === 'xml') return typeof item.data === 'string' ? item.data : JSON.stringify(item.data || '')
    return ''
  }).filter(Boolean).join(' ')
  let text
  if (!segments || !basic || segments.includes(basic)) text = segments || basic
  else if (basic.includes(segments)) text = basic
  else text = cleanText(basic + ' ' + segments)
  return text.replace(/^[#＃/!！]+\s*/, '')
}

function withCommandPrefixes(rules) {
  return rules.map(rule => rule.reg?.startsWith('^')
    ? { ...rule, reg: `^(?:[#＃/!！])?\\s*${rule.reg.slice(1)}` }
    : rule)
}

function routedEvent(e, text) {
  const routed = Object.create(e)
  if (typeof e.reply === 'function') routed.reply = e.reply.bind(e)
  routed.msg = text
  routed.raw_message = text
  routed.rawMessage = text
  routed.message = []
  return routed
}

function platformFrom(value) {
  const word = cleanText(value).toLowerCase()
  return Object.entries(PLATFORMS).find(([, item]) => item.aliases.includes(word))?.[0] || ''
}

function parsePlatformAndKeyword(raw, fallback = '') {
  const value = cleanText(raw)
  const splitAt = value.search(/\s/)
  const first = splitAt < 0 ? value : value.slice(0, splitAt)
  const platform = platformFrom(first)
  return platform
    ? { platform, keyword: value.slice(first.length).trim() }
    : { platform: fallback, keyword: value }
}

function eventKey(e) {
  return String(e.group_id || e.user_id || e.sender?.user_id || 'unknown')
}

function saveSession(e, songs, label) {
  if (sessions.size >= 500 && !sessions.has(eventKey(e))) sessions.delete(sessions.keys().next().value)
  const validSongs = Array.isArray(songs) ? songs.filter(isUsableSong) : []
  const session = { songs: validSongs, label, expires: Date.now() + SESSION_TTL, selectedSongIndex: 0 }
  sessions.set(eventKey(e), session)
  return session
}

function durationText(seconds) {
  const totalSeconds = Math.floor(Number(seconds) || 0)
  if (totalSeconds <= 0) return ''
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

function makeSong(platform, songId, name, singers, extra = {}) {
  if (!songId) return null
  return {
    platform,
    songId: String(songId),
    name: cleanText(name) || '未知歌曲',
    singers: cleanText(singers) || '未知歌手',
    album: cleanText(extra.album),
    albumId: cleanText(extra.albumId),
    albumAudioId: cleanText(extra.albumAudioId),
    kugouVariants: Array.isArray(extra.kugouVariants) ? extra.kugouVariants : [],
    duration: Number(extra.duration) || 0,
    coverUrl: cleanText(extra.coverUrl),
    payplay: Boolean(extra.payplay),
  }
}

function isUsableSong(song) {
  return Boolean(song && typeof song === 'object' && song.platform && song.songId)
}

async function requestJson(input, options = {}) {
  const { timeoutMs, ...fetchOptions } = options
  const controller = new AbortController()
  const timeout = Math.max(1000, Math.min(120000, Number(timeoutMs) || Number(config.requestTimeout) || 15000))
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(input, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        ...options.headers,
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function requestText(input, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(config.requestTimeout) || 15000))
  try {
    const response = await fetch(input, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*',
        ...options.headers,
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

function queryUrl(base, params) {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function artistsOf(list) {
  if (!Array.isArray(list)) return ''
  return list.map(item => typeof item === 'string' ? item : item?.name || item?.title || '').filter(Boolean).join('/')
}

async function searchNetease(keyword, limit) {
  const url = queryUrl('https://music.163.com/api/search/get/web', {
    s: keyword, type: 1, offset: 0, limit, total: 'true',
  })
  const data = await requestJson(url, { headers: { Referer: 'https://music.163.com/' } })
  const songs = (data?.result?.songs || []).map(item => makeSong('netease', item.id, item.name, artistsOf(item.artists || item.ar), {
    album: item.album?.name || item.al?.name,
    duration: (item.duration || item.dt || 0) / 1000,
    coverUrl: item.album?.picUrl || item.al?.picUrl || item.album?.blurPicUrl || item.coverUrl || item.cover,
    payplay: [1, 4].includes(Number(item.fee)),
  })).filter(Boolean)
  if (songs.length) {
    try {
      const detail = await requestJson(queryUrl('https://music.163.com/api/song/detail', {
        ids: `[${songs.map(song => song.songId).join(',')}]`,
      }), { headers: { Referer: 'https://music.163.com/' } })
      const covers = new Map((detail?.songs || []).map(item => [String(item.id),
        item.album?.picUrl || item.al?.picUrl || item.album?.blurPicUrl || item.picUrl || item.coverUrl || item.cover || '',
      ]))
      for (const song of songs) song.coverUrl = covers.get(song.songId) || song.coverUrl
    } catch { /* Covers are optional; preserve search results when details fail. */ }
  }
  return songs
}

async function searchQq(keyword, limit) {
  await ensureQqActiveCookie()
  const body = {
    comm: { ct: '19', cv: '1859', uin: '0' },
    req: {
      method: 'DoSearchForQQMusicDesktop',
      module: 'music.search.SearchCgiService',
      param: { grp: 1, num_per_page: limit, page_num: 1, query: keyword, search_type: 0 },
    },
  }
  const data = await requestJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://y.qq.com/portal/player.html',
      ...(config.qqCookie ? { Cookie: config.qqCookie } : {}),
    },
    body: JSON.stringify(body),
  })
  const list = data?.req?.data?.body?.song?.list || []
  return list.map(item => makeSong('qq', item.mid, item.title, artistsOf(item.singer), {
    album: item.album?.name,
    duration: item.interval,
    coverUrl: item.album?.mid ? `https://y.qq.com/music/photo_new/T002R300x300M000${item.album.mid}.jpg` : '',
    payplay: Number(item.pay?.pay_play) > 0,
  })).filter(Boolean)
}

async function searchKugou(keyword, limit) {
  const url = queryUrl('https://mobiles.kugou.com/api/v3/search/song', {
    format: 'json', keyword, page: 1, pagesize: limit, showtype: 1,
  })
  const data = await requestJson(url)
  return (data?.data?.info || []).map(item => {
    const matchHash = String(item.hash || '').toLowerCase()
    const groups = Array.isArray(item.group) ? item.group : []
    const variant = groups.find(group => String(group.hash || '').toLowerCase() === matchHash)
      || item.group?.[0]
      || {}
    const kugouVariants = []
    const seen = new Set([`${matchHash}:${item.album_id || ''}:${item.album_audio_id || item.mixsongid || ''}`])
    for (const group of groups) {
      const hash = String(group.hash || '').toLowerCase()
      if (!/^[\da-f]{32}$/.test(hash)) continue
      const albumId = cleanText(group.album_id)
      const albumAudioId = cleanText(group.album_audio_id || group.mixsongid)
      const key = `${hash}:${albumId}:${albumAudioId}`
      if (seen.has(key)) continue
      seen.add(key)
      kugouVariants.push({ hash, albumId, albumAudioId })
    }
    return makeSong('kugou', item.hash, item.songname, item.singername, {
      album: item.album_name || variant.album_name,
      albumId: item.album_id || variant.album_id,
      albumAudioId: item.album_audio_id || item.mixsongid || variant.album_audio_id || variant.mixsongid,
      kugouVariants,
      duration: item.duration,
      coverUrl: cleanText(
        item.album_img || item.imgurl || item.trans_param?.union_cover
        || variant.album_img || variant.imgurl || variant.trans_param?.union_cover
        || groups.find(group => group.trans_param?.union_cover)?.trans_param?.union_cover,
      ).replace('{size}', '480').replace(/^http:\/\//i, 'https://'),
      payplay: Number(item.privilege) > 0 || Number(variant.privilege) > 0,
    })
  }).filter(Boolean)
}

const providers = {
  netease: { search: searchNetease },
  qq: { search: searchQq },
  kugou: { search: searchKugou },
}

async function neteaseDetail(id) {
  const data = await requestJson(queryUrl('https://music.163.com/api/song/detail', { ids: `[${id}]` }), {
    headers: { Referer: 'https://music.163.com/' },
  })
  const item = data?.songs?.[0]
  if (!item) return null
  return makeSong('netease', item.id, item.name, artistsOf(item.artists || item.ar), {
    album: item.album?.name || item.al?.name,
    duration: (item.duration || item.dt || 0) / 1000,
    coverUrl: item.album?.picUrl || item.al?.picUrl,
    payplay: [1, 4].includes(Number(item.fee)),
  })
}

async function qqDetail(id) {
  await ensureQqActiveCookie()
  const params = { format: 'json', platform: 'yqq', inCharset: 'utf8', outCharset: 'utf-8' }
  params[/^\d+$/.test(id) ? 'songid' : 'songmid'] = id
  const data = await requestJson(queryUrl('https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg', params), {
    headers: { Referer: 'https://y.qq.com/portal/player.html', ...(config.qqCookie ? { Cookie: config.qqCookie } : {}) },
  })
  const item = data?.data?.[0]
  if (!item?.mid) return null
  return makeSong('qq', item.mid, item.name, artistsOf(item.singer), {
    album: item.album?.name, duration: item.interval,
    coverUrl: item.album?.mid ? `https://y.qq.com/music/photo_new/T002R300x300M000${item.album.mid}.jpg` : '',
    payplay: Number(item.pay?.pay_play) > 0,
  })
}

async function kugouDetail(hash, albumId = '', albumAudioId = '') {
  const data = await requestJson(queryUrl('http://m.kugou.com/app/i/getSongInfo.php', { cmd: 'playInfo', hash }), {
    headers: { Referer: 'https://m.kugou.com/' },
  })
  if (!data?.songName) return null
  return makeSong('kugou', data.hash || hash, data.songName, data.author_name, {
    album: data.album_name,
    albumId: data.album_id || albumId,
    albumAudioId: data.album_audio_id || data.mixsongid || albumAudioId,
    duration: data.timeLength, coverUrl: cleanText(data.album_img).replace('{size}', '480'), payplay: Number(data.privilege) > 0,
  })
}

async function qqPlaylistDetail(id) {
  await ensureQqActiveCookie()
  const url = queryUrl('https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', {
    type: 1, json: 1, utf8: 1, onlysong: 0, nosign: 1, disstid: id,
    g_tk: 5381, loginUin: 0, hostUin: 0, format: 'json', inCharset: 'GB2312',
    outCharset: 'utf-8', notice: 0, platform: 'yqq', needNewCode: 0,
  })
  const data = await requestJson(url, {
    headers: { Referer: 'https://y.qq.com/', ...(config.qqCookie ? { Cookie: config.qqCookie } : {}) },
  })
  const collection = data?.cdlist?.[0]
  const songs = (collection?.songlist || []).map(item => makeSong(
    'qq', item.mid || item.songmid || item.songid || item.id,
    item.name || item.songname || item.title,
    artistsOf(item.singer || item.singers) || item.singername || item.artist,
    {
      album: item.album?.name || item.albumname || item.album_name,
      albumId: item.album_id,
      albumAudioId: item.album_audio_id || item.mixsongid,
      duration: item.interval || item.duration,
      coverUrl: (item.album?.mid || item.albummid)
        ? `https://y.qq.com/music/photo_new/T002R300x300M000${item.album?.mid || item.albummid}.jpg`
        : '',
      payplay: Number(item.pay?.pay_play ?? item.payplay) > 0,
    },
  )).filter(Boolean).slice(0, Number(config.maxList) || 5)
  return { name: collection?.dissname || collection?.name || 'QQ音乐歌单', songs }
}

async function kugouPlaylistDetail(id) {
  const url = `https://m.kugou.com/plist/list/${encodeURIComponent(id)}?json=true`
  const data = await requestJson(url, { headers: { Referer: 'https://m.kugou.com/' } })
  const payload = data?.data || data
  const collection = payload?.list || data?.list || {}
  const items = Array.isArray(payload?.info) ? payload.info
    : Array.isArray(payload?.songs) ? payload.songs
      : Array.isArray(collection?.info) ? collection.info
        : Array.isArray(collection?.songs) ? collection.songs
          : Array.isArray(collection) ? collection : []
  const songs = items.map(item => {
    const filename = cleanText(item.songname || item.song_name || item.filename || item.name)
    const parts = filename.split(/\s+-\s+/, 2)
    const songName = item.songname || item.song_name || (parts.length > 1 ? parts[1] : filename)
    const singer = item.singername || item.singer || item.author_name || (parts.length > 1 ? parts[0] : '')
    let duration = Number(item.duration || item.time_length || item.interval) || 0
    if (!duration && Number(item.timelength)) duration = Number(item.timelength) > 10000 ? Number(item.timelength) / 1000 : Number(item.timelength)
    return makeSong('kugou', item.hash || item.audio_id, songName, singer, {
      album: item.album_name || item.albumname || item.album,
      albumId: item.album_id,
      albumAudioId: item.album_audio_id || item.mixsongid,
      duration,
      coverUrl: cleanText(item.imgurl || item.album_img || item.cover).replace('{size}', '480'),
      payplay: Number(item.privilege) > 0,
    })
  }).filter(Boolean).slice(0, Number(config.maxList) || 5)
  return { name: collection?.specialname || collection?.name || payload?.specialname || '酷狗歌单', songs }
}

function loadQqCredential() {
  try {
    const value = JSON.parse(fs.readFileSync(CREDENTIAL_FILE, 'utf8'))
    if (!value?.musickey || !value?.refresh_token) return null
    return value
  } catch {
    return null
  }
}

function saveQqCredential(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const temporary = `${CREDENTIAL_FILE}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, CREDENTIAL_FILE)
}

function qqCredentialExpiring(credential) {
  const created = Number(credential?.musickey_create_time) || 0
  const expires = Number(credential?.key_expires_in) || 0
  if (!created || !expires) return true
  const buffer = Math.min(Math.max(Math.floor(expires / 5), 3600), 7 * 86400)
  return Date.now() / 1000 >= created + expires - buffer
}

let qqRefreshPromise = null
let lastQqRefreshAttempt = 0

async function refreshQqCredential() {
  if (qqRefreshPromise) return qqRefreshPromise
  qqRefreshPromise = (async () => {
    const old = loadQqCredential()
    if (!old) return { ok: false, message: '未找到已保存的 QQ 音乐移动端凭据' }
    const body = {
      comm: { ct: 11, cv: '12080008', tmeLoginType: Number(old.login_type) || 2 },
      req: {
        module: 'music.login.LoginServer', method: 'Login',
        param: {
          openid: old.openid, access_token: old.access_token, refresh_token: old.refresh_token,
          expired_in: old.expired_at, musicid: old.musicid, musickey: old.musickey,
          refresh_key: old.refresh_key, loginMode: 2,
        },
      },
    }
    try {
      const result = await requestJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
        body: JSON.stringify(body),
      })
      const block = result?.req
      const data = block?.data
      if (Number(block?.code) !== 0 || !data || !data.musickey) {
        return { ok: false, message: block?.errMsg || 'QQ 音乐未返回新的凭据' }
      }
      const updated = {
        ...old,
        openid: data.openid || old.openid,
        refresh_token: data.refresh_token || old.refresh_token,
        access_token: data.access_token || old.access_token,
        expired_at: Number(data.expired_at) || old.expired_at,
        musickey: String(data.musickey),
        unionid: data.unionid || old.unionid,
        str_musicid: data.str_musicid || old.str_musicid,
        refresh_key: data.refresh_key || old.refresh_key,
        musickey_create_time: Number(data.musickeyCreateTime) || old.musickey_create_time,
        key_expires_in: Number(data.keyExpiresIn) || old.key_expires_in,
        nick: data.nick || old.nick,
      }
      saveQqCredential(updated)
      config.qqCookie = `uin=${updated.musicid}; qm_keyst=${updated.musickey}; qqmusic_key=${updated.musickey}`
      saveConfig()
      logger.info(`[MusicUID] QQ 音乐凭据刷新成功（${updated.nick || updated.musicid}）`)
      return { ok: true, message: '刷新成功', credential: updated }
    } catch (err) {
      logger.warn(`[MusicUID] QQ 音乐凭据刷新失败：${err.message}`)
      return { ok: false, message: err.message }
    }
  })()
  try { return await qqRefreshPromise } finally { qqRefreshPromise = null }
}

async function ensureQqActiveCookie() {
  const credential = loadQqCredential()
  if (credential && qqCredentialExpiring(credential) && Date.now() - lastQqRefreshAttempt > 300000) {
    lastQqRefreshAttempt = Date.now()
    const result = await refreshQqCredential()
    if (!result.ok) logger.warn(`[MusicUID] QQ 音乐静默续签失败：${result.message}`)
  }
  return config.qqCookie
}

function hash33(value, initial = 0) {
  let hash = initial >>> 0
  for (const char of String(value)) hash = (hash * 33 + char.codePointAt(0)) & 0x7fffffff
  return hash >>> 0
}

function cookieFromHeaders(headers, name) {
  const value = headers.get('set-cookie') || ''
  return value.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,\\s]+)`))?.[1] || ''
}

function setCookiePairs(headers, responseUrl) {
  const origin = new URL(responseUrl)
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie') || '']
  return values.flatMap(value => value.split(/,(?=\s*[^=;,\s]+=)/)).map(serialized => {
    const parts = serialized.split(';')
    const pair = parts.shift()?.trim() || ''
    const separator = pair.indexOf('=')
    if (separator <= 0) return null
    const attributes = new Map(parts.map(item => {
      const index = item.indexOf('=')
      return index < 0
        ? [item.trim().toLowerCase(), '']
        : [item.slice(0, index).trim().toLowerCase(), item.slice(index + 1).trim()]
    }))
    const explicitDomain = attributes.get('domain')?.replace(/^\./, '').toLowerCase()
    const domain = explicitDomain || origin.hostname.toLowerCase()
    if (explicitDomain && origin.hostname.toLowerCase() !== domain && !origin.hostname.toLowerCase().endsWith(`.${domain}`)) return null
    const defaultPath = origin.pathname.slice(0, origin.pathname.lastIndexOf('/')) || '/'
    const path = attributes.get('path')?.startsWith('/') ? attributes.get('path') : defaultPath
    const maxAge = Number(attributes.get('max-age'))
    const expires = attributes.has('expires') ? Date.parse(attributes.get('expires')) : NaN
    return {
      name: pair.slice(0, separator), value: pair.slice(separator + 1), domain, path,
      hostOnly: !explicitDomain, secure: attributes.has('secure'),
      expiresAt: Number.isFinite(maxAge) ? Date.now() + maxAge * 1000 : (Number.isFinite(expires) ? expires : 0),
      deleteCookie: (Number.isFinite(maxAge) && maxAge <= 0) || (Number.isFinite(expires) && expires <= Date.now()),
    }
  }).filter(Boolean)
}

function cookieKey(cookie) {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`
}

function setCookieValue(cookies, name, value, domain) {
  const cookie = { name, value, domain, path: '/', hostOnly: false, secure: true, expiresAt: 0 }
  const jar = new Map((cookies || []).map(item => [cookieKey(item), item]))
  const key = cookieKey(cookie)
  jar.delete(key)
  jar.set(key, cookie)
  return [...jar.values()]
}

function mergeCookiePairs(previous, headers, responseUrl) {
  const cookies = new Map((previous || []).map(cookie => [cookieKey(cookie), cookie]))
  for (const cookie of setCookiePairs(headers, responseUrl)) {
    const key = cookieKey(cookie)
    if (cookie.deleteCookie) cookies.delete(key)
    else {
      cookies.delete(key)
      cookies.set(key, cookie)
    }
  }
  return [...cookies.values()]
}

function cookieValue(cookies, name) {
  for (let index = (cookies || []).length - 1; index >= 0; index -= 1) {
    const cookie = cookies[index]
    if (typeof cookie === 'string' && cookie.startsWith(`${name}=`)) return cookie.slice(name.length + 1)
    if (cookie?.name === name) return cookie.value
  }
  return ''
}

function cookieHeader(cookies, requestUrl) {
  const url = new URL(requestUrl)
  const host = url.hostname.toLowerCase()
  const path = url.pathname || '/'
  const matches = (cookies || []).filter(cookie => {
    const domainMatches = cookie.hostOnly
      ? host === cookie.domain
      : host === cookie.domain || host.endsWith(`.${cookie.domain}`)
    const pathMatches = path === cookie.path || path.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)
    return domainMatches && pathMatches && (!cookie.secure || url.protocol === 'https:')
      && (!cookie.expiresAt || cookie.expiresAt > Date.now())
  }).sort((left, right) => right.path.length - left.path.length)
  return matches.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

const QQ_LOGIN_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function createQqLoginSession() {
  const xloginUrl = queryUrl('https://xui.ptlogin2.qq.com/cgi-bin/xlogin', {
    appid: '716027609', daid: '383', s_url: 'https://graph.qq.com/oauth2.0/login_jump',
    style: '20', target: 'self', pt_3rd_aid: '100497308',
  })
  const xlogin = await fetch(xloginUrl, {
    headers: { Referer: 'https://y.qq.com/', 'User-Agent': QQ_LOGIN_USER_AGENT },
    redirect: 'manual', signal: AbortSignal.timeout(10000),
  })
  let cookies = setCookiePairs(xlogin.headers, xloginUrl)
  if (!xlogin.ok || !cookieValue(cookies, 'pt_login_sig')) throw new Error('初始化 QQ 登录会话失败（未获取 pt_login_sig）')
  const qrUrl = queryUrl('https://ssl.ptlogin2.qq.com/ptqrshow', {
    appid: '716027609', e: '2', l: 'M', s: '3', d: '72', v: '4', t: Date.now() / 1000,
    daid: '383', pt_3rd_aid: '100497308', u1: 'https://graph.qq.com/oauth2.0/login_jump',
  })
  const response = await fetch(qrUrl, {
    headers: { Cookie: cookieHeader(cookies, qrUrl), Referer: xloginUrl, 'User-Agent': QQ_LOGIN_USER_AGENT },
    redirect: 'manual', signal: AbortSignal.timeout(10000),
  })
  cookies = mergeCookiePairs(cookies, response.headers, qrUrl)
  const qrsig = cookieValue(cookies, 'qrsig') || cookieFromHeaders(response.headers, 'qrsig')
  if (!response.ok || !qrsig) throw new Error('获取 QQ 登录二维码失败')
  if (!cookieValue(cookies, 'qrsig')) cookies = setCookieValue(cookies, 'qrsig', qrsig, 'ptlogin2.qq.com')
  return {
    platform: 'qq', key: qrsig, qrUrl, xloginUrl,
    cookies,
    qrBytes: Buffer.from(await response.arrayBuffer()),
    status: 'waiting', message: '请使用手机 QQ 扫码授权（支持移动端凭据自动续期）',
  }
}

async function requestNeteaseLogin(url, payload, cookies = []) {
  const csrfToken = cookieValue(cookies, '__csrf')
  const form = new URLSearchParams(weapiForm({ ...payload, csrf_token: csrfToken }))
  const savedCookie = cookieHeader(cookies, url)
  const response = await fetch(url, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com/', Origin: 'https://music.163.com',
      Cookie: [savedCookie, savedCookie.includes('os=') ? '' : 'os=pc', savedCookie.includes('appver=') ? '' : 'appver=2.10.13'].filter(Boolean).join('; '),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body: form,
  })
  const updatedCookies = mergeCookiePairs(cookies, response.headers, url)
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error(`网易云登录接口返回了无效响应（HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(`网易云登录接口请求失败（HTTP ${response.status}）`)
  return { data, cookies: updatedCookies }
}

async function createNeteaseLoginSession() {
  const keyUrl = queryUrl('https://music.163.com/weapi/login/qrcode/unikey', { csrf_token: '' })
  const result = await requestNeteaseLogin(keyUrl, { type: 1, noCheckToken: true })
  const key = String(result.data?.unikey || result.data?.data?.unikey || '')
  if (Number(result.data?.code) !== 200 || !key) {
    throw new Error(result.data?.message || '网易云没有返回登录二维码凭据')
  }
  const qrUrl = `https://music.163.com/login?codekey=${encodeURIComponent(key)}`
  return {
    platform: 'netease', key, qrUrl, cookies: result.cookies,
    qrBytes: await QRCode.toBuffer(qrUrl, { errorCorrectionLevel: 'L', margin: 2, scale: 8 }),
    status: 'waiting', message: '请使用网易云音乐 APP 扫码并确认登录',
  }
}

async function checkNeteaseLoginSession(session) {
  const pollUrl = queryUrl('https://music.163.com/weapi/login/qrcode/client/login', { csrf_token: cookieValue(session.cookies, '__csrf') })
  const result = await requestNeteaseLogin(pollUrl, { key: session.key, type: 1 }, session.cookies)
  const updatedSession = { ...session, cookies: result.cookies }
  const data = result.data?.data || result.data || {}
  const code = Number(data.code)
  if (code === 801) return { ...updatedSession, status: 'waiting', message: '等待网易云音乐扫码' }
  if (code === 802) return { ...updatedSession, status: 'scanned', message: '已扫码，请在网易云音乐中确认登录' }
  if (code === 800) return { ...updatedSession, status: 'expired', message: '二维码已过期，请重新发起登录' }
  if (code === 803) {
    const bodyCookie = typeof data.cookie === 'string' ? data.cookie : ''
    const musicU = cookieValue(updatedSession.cookies, 'MUSIC_U')
      || bodyCookie.match(/(?:^|;\s*)MUSIC_U=([^;]+)/)?.[1]
    if (!musicU) return { ...updatedSession, status: 'failed', message: '网易云已确认登录，但没有收到 MUSIC_U 凭据，请重新扫码' }
    const cookie = `MUSIC_U=${musicU}; os=pc`
    const authCookies = setCookieValue(updatedSession.cookies, 'MUSIC_U', musicU, 'music.163.com')
    let nickname = data.profile?.nickname || data.account?.userName || data.account?.username || ''
    try {
      const account = await requestNeteaseLogin('https://music.163.com/weapi/w/nuser/account/get', {}, authCookies)
      const accountData = account.data?.data || account.data || {}
      nickname = accountData.profile?.nickname || accountData.account?.userName || accountData.account?.username || nickname
    } catch (err) {
      logger.debug(`[MusicUID] 网易云扫码成功，读取账号昵称失败：${err.message}`)
    }
    return { ...updatedSession, status: 'success', cookie, nickname, message: '网易云登录成功' }
  }
  return { ...updatedSession, status: 'failed', message: data.message || result.data?.message || `未知状态：${code}` }
}

async function exchangeQqMobileCredential(sigUrl, nick, initialCookies = [], xloginUrl = 'https://xui.ptlogin2.qq.com/') {
  const parsed = new URL(sigUrl)
  const uin = parsed.searchParams.get('uin') || ''
  const ptsigx = parsed.searchParams.get('ptsigx') || ''
  if (!uin || !ptsigx) throw new Error('登录结果缺少 uin 或 ptsigx')
  const params = {
    uin, pttype: '1', service: 'ptqrlogin', nodirect: '0', ptsigx,
    s_url: 'https://graph.qq.com/oauth2.0/login_jump', ptlang: '2052', ptredirect: '100',
    aid: '716027609', daid: '383', j_later: '0', low_login_hour: '0', regmaster: '0',
    pt_login_type: '3', pt_aid: '0', pt_aaid: '16', pt_light: '0', pt_3rd_aid: '100497308',
  }
  const checkUrl = queryUrl('https://ssl.ptlogin2.graph.qq.com/check_sig', params)
  const check = await fetch(checkUrl, {
    headers: {
      Cookie: cookieHeader(initialCookies, checkUrl), Referer: xloginUrl,
      'User-Agent': QQ_LOGIN_USER_AGENT,
    },
    redirect: 'manual', signal: AbortSignal.timeout(10000),
  })
  const checkCookies = mergeCookiePairs(initialCookies, check.headers, checkUrl)
  const pSkey = cookieValue(checkCookies, 'p_skey') || cookieFromHeaders(check.headers, 'p_skey')
  if (!pSkey) throw new Error('未获取到 p_skey 鉴权票据')
  const sigCookies = cookieValue(checkCookies, 'p_skey') ? checkCookies : setCookieValue(checkCookies, 'p_skey', pSkey, 'qq.com')
  const auth = new URLSearchParams({
    response_type: 'code', client_id: '100497308',
    redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
    scope: 'get_user_info,get_app_friends', state: 'state', switch: '', from_ptlogin: '1', src: '1',
    update_auth: '1', openapi: '1010_1030', g_tk: String(hash33(pSkey, 5381)),
    auth_time: String(Date.now()), ui: randomUUID().toUpperCase(),
  })
  const authUi = auth.get('ui')
  const authCookies = setCookieValue(setCookieValue(sigCookies, 'p_skey', pSkey, 'qq.com'), 'ui', authUi, 'qq.com')
  const authResponse = await fetch('https://graph.qq.com/oauth2.0/authorize', {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(authCookies, 'https://graph.qq.com/oauth2.0/authorize'),
      Referer: xloginUrl, 'User-Agent': QQ_LOGIN_USER_AGENT,
    }, body: auth, signal: AbortSignal.timeout(10000),
  })
  const location = authResponse.headers.get('location') || ''
  const code = new URL(location, 'https://graph.qq.com').searchParams.get('code')
  if (!code) {
    let locationHint = 'none'
    try {
      const target = new URL(location, 'https://graph.qq.com')
      locationHint = `${target.origin}${target.pathname}`
    } catch { /* Keep the no-location hint. */ }
    let responseHint = ''
    try {
      const target = new URL(location, 'https://graph.qq.com')
      const details = ['which', 'display', 'error', 'error_description']
        .map(key => target.searchParams.get(key) ? `${key}=${target.searchParams.get(key).slice(0, 100)}` : '')
        .filter(Boolean)
      if (details.length) responseHint = `?${details.join('&')}`
    } catch { /* Keep the path-only diagnostic. */ }
    const cookieNames = cookieHeader(authCookies, 'https://graph.qq.com/oauth2.0/authorize').split(';').map(item => item.trim().split('=', 1)[0]).filter(Boolean).join(',') || 'none'
    throw new Error('OAuth 未返回 code（HTTP ' + authResponse.status + '，Location: ' + locationHint + responseHint + '；check_sig HTTP ' + check.status + '；授权 Cookie: ' + cookieNames + '）')
  }
  const login = await requestJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
    body: JSON.stringify({
      comm: { tmeLoginType: 2 },
      req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code } },
    }),
  })
  const block = login?.req
  const data = block?.data
  if (Number(block?.code) !== 0 || !data?.musickey || !data?.refresh_token) {
    throw new Error(block?.errMsg || '移动端登录授权被拒绝')
  }
  return {
    openid: String(data.openid || ''), refresh_token: String(data.refresh_token),
    access_token: String(data.access_token || ''), expired_at: Number(data.expired_at) || 0,
    musicid: Number(data.musicid || uin), musickey: String(data.musickey),
    unionid: String(data.unionid || ''), str_musicid: String(data.str_musicid || ''),
    refresh_key: String(data.refresh_key || ''),
    musickey_create_time: Number(data.musickeyCreateTime) || Math.floor(Date.now() / 1000),
    key_expires_in: Number(data.keyExpiresIn) || 259200, login_type: 2,
    nick: String(data.nick || nick || ''),
  }
}

async function checkQqLoginSession(session) {
  const params = {
    u1: 'https://graph.qq.com/oauth2.0/login_jump', ptqrtoken: String(hash33(session.key)),
    ptredirect: '0', h: '1', t: '1', g: '1', from_ui: '1', ptlang: '2052',
    action: `0-0-${Date.now()}`, js_ver: '20102616', js_type: '1', pt_uistyle: '40',
    login_sig: cookieValue(session.cookies, 'pt_login_sig'),
    aid: '716027609', daid: '383', pt_3rd_aid: '100497308', has_onekey: '1',
  }
  const pollUrl = queryUrl('https://ssl.ptlogin2.qq.com/ptqrlogin', params)
  const response = await fetch(pollUrl, {
    headers: {
      Cookie: cookieHeader(session.cookies, pollUrl),
      Referer: session.xloginUrl || 'https://xui.ptlogin2.qq.com/',
      'User-Agent': QQ_LOGIN_USER_AGENT,
    },
    signal: AbortSignal.timeout(10000),
  })
  const updatedSession = { ...session, cookies: mergeCookiePairs(session.cookies, response.headers, pollUrl) }
  const text = await response.text()
  const match = text.match(/ptuiCB\((.*?)\)/)
  if (!match) return { ...updatedSession, status: 'waiting' }
  const parts = match[1].split(',').map(item => item.trim().replace(/^['"]|['"]$/g, ''))
  const code = parts[0]
  if (code === '66') return { ...updatedSession, status: 'waiting', message: '等待手机 QQ 扫码' }
  if (code === '67') return { ...updatedSession, status: 'scanned', message: '已扫码，请在手机 QQ 点击确认登录' }
  if (code === '65') return { ...updatedSession, status: 'expired', message: '二维码已过期，请重新发起登录' }
  if (code === '0') {
    try {
      const credential = await exchangeQqMobileCredential(parts[2] || '', parts[5] || 'QQ用户', updatedSession.cookies, updatedSession.xloginUrl)
      saveQqCredential(credential)
      const cookie = `uin=${credential.musicid}; qm_keyst=${credential.musickey}; qqmusic_key=${credential.musickey}`
      config.qqCookie = cookie
      saveConfig()
      return { ...updatedSession, status: 'success', cookie, credential, nickname: credential.nick, message: '登录成功，已启用移动端凭据自动续期' }
    } catch (err) {
      return { ...updatedSession, status: 'failed', message: `QQ 凭据换取失败：${err.message}` }
    }
  }
  return { ...updatedSession, status: 'failed', message: parts[4] || `登录失败（${code}）` }
}

function kugouSignature(params) {
  const values = Object.entries(params).map(([key, value]) => `${key}=${value}`).sort().join('')
  return md5(`NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt${values}NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt`)
}

async function createKugouLoginSession() {
  const params = {
    appid: KUGOU_QR_APPID, type: 1, plat: 4,
    qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${KUGOU_MUSIC_APPID}&`,
    srcappid: 2919, clienttime: Math.floor(Date.now() / 1000), clientver: 20489,
    dfid: '-', mid: '12345678901234567890123456789012', uuid: '-',
  }
  params.signature = kugouSignature(params)
  const result = await requestJson(queryUrl('https://login-user.kugou.com/v2/qrcode', params), {
    headers: { Referer: 'https://www.kugou.com/' },
  })
  const data = result?.data || {}
  if (!data.qrcode) throw new Error('获取酷狗二维码失败')
  const qrUrl = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${encodeURIComponent(data.qrcode)}`
  let qrBytes
  if (data.qrcode_img?.startsWith('data:image/')) {
    qrBytes = Buffer.from(data.qrcode_img.split(',', 2)[1], 'base64')
  } else {
    qrBytes = await QRCode.toBuffer(qrUrl, { errorCorrectionLevel: 'L', margin: 2, scale: 8 })
  }
  return { platform: 'kugou', key: data.qrcode, qrUrl, qrBytes, status: 'waiting', message: '请使用酷狗音乐 APP 扫码并确认登录' }
}

async function checkKugouLoginSession(session) {
  const params = {
    plat: 4, appid: KUGOU_MUSIC_APPID, srcappid: 2919, qrcode: session.key,
    clienttime: Math.floor(Date.now() / 1000), clientver: 20489, dfid: '-',
    mid: '12345678901234567890123456789012', uuid: '-',
  }
  params.signature = kugouSignature(params)
  const result = await requestJson(queryUrl('https://login-user.kugou.com/v2/get_userinfo_qrcode', params), {
    headers: { Referer: 'https://www.kugou.com/' },
  })
  const data = result?.data || {}
  const code = Number(data.status)
  if (code === 1) return { ...session, status: 'waiting', message: '等待扫码中…' }
  if (code === 2) return { ...session, status: 'scanned', nickname: data.nickname || '', message: '已扫码，请在手机上确认登录' }
  if (code === 3) return { ...session, status: 'expired', message: '二维码已失效，请重新发起登录' }
  if (code === 4) {
    const token = String(data.token || data.t || '')
    const userId = String(data.userid || data.user_id || data.kugou_id || '')
    if (!token || !userId) return { ...session, status: 'failed', message: '酷狗已确认登录，但没有返回有效的 token / userid' }
    const cookie = `token=${token}; userid=${userId}`
    return { ...session, status: 'success', cookie, nickname: data.nickname || data.username || '', message: '酷狗登录成功' }
  }
  return { ...session, status: 'failed', message: result?.error_msg || `未知状态：${code}` }
}

function formatQqCookie(cookie) {
  const parsed = Object.fromEntries(cleanText(cookie).split(';').map(item => item.trim()).filter(Boolean).map(item => {
    const index = item.indexOf('=')
    return index < 0 ? [item, ''] : [item.slice(0, index), item.slice(index + 1)]
  }))
  const keys = ['uin', 'qm_keyst', 'qqmusic_key', 'pskey', 'skey', 'p_skey', 'p_uin']
  const filtered = keys.filter(key => parsed[key]).map(key => `${key}=${parsed[key]}`)
  return filtered.length ? filtered.join('; ') : cleanText(cookie)
}

function maskSecret(value) {
  const text = cleanText(value)
  if (!text) return '未配置'
  if (text.length <= 12) return `${text.slice(0, 3)}***${text.slice(-3)}`
  return `${text.slice(0, 6)}******${text.slice(-6)}`
}

function isLoginAuthorized(e) {
  const id = cleanText(e.user_id || e.sender?.user_id)
  return isOwner(e) || (Array.isArray(config.loginWhitelist) && config.loginWhitelist.map(String).includes(id))
}

function eventAtIds(e) {
  const ids = []
  if (Array.isArray(e.message)) {
    for (const segment of e.message) if (segment?.type === 'at' && segment.qq) ids.push(String(segment.qq))
  }
  if (e.at && typeof e.at !== 'boolean') ids.push(String(e.at))
  return [...new Set(ids)]
}

function extractUserIds(e, args) {
  const ids = eventAtIds(e)
  for (const token of cleanText(args).split(/\s+/)) {
    if (/^[\da-zA-Z_-]+$/.test(token) && !ids.includes(token)) ids.push(token)
  }
  return ids
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function pollLogin(e, provider, session, task) {
  let scannedNotified = false
  let consecutiveErrors = 0
  const check = ({ qq: checkQqLoginSession, kugou: checkKugouLoginSession, netease: checkNeteaseLoginSession })[provider]
  for (let round = 0; round < 56 && !task.cancelled; round += 1) {
    await delay(2500)
    if (task.cancelled) return
    try {
      session = await check(session)
    } catch (err) {
      logger.debug(`[MusicUID] ${provider} 登录状态轮询异常：${err.message}`)
      consecutiveErrors += 1
      if (consecutiveErrors >= 3) {
        await e.reply(`❌【${PLATFORMS[provider].name}】连续查询登录状态失败：${err.message}`)
        return
      }
      continue
    }
    consecutiveErrors = 0
    if (session.status === 'scanned' && !scannedNotified) {
      scannedNotified = true
      logger.info(`[MusicUID] ${provider} 登录二维码已扫描，等待确认`)
      await e.reply(`✅【${PLATFORMS[provider].name}】已检测到扫码，请在手机上确认授权。`)
    }
    if (session.status === 'success') {
      if (provider === 'kugou' || provider === 'netease') {
        config[provider === 'kugou' ? 'kugouCookie' : 'neteaseCookie'] = session.cookie
        saveConfig()
      }
      logger.info(`[MusicUID] ${provider} 扫码登录成功，Cookie 已保存`)
      await e.reply(`🎉【${PLATFORMS[provider].name}】扫码登录成功！\n用户：${session.nickname || '已登录'}\n凭据已保存并立即生效。`)
      return
    }
    if (session.status === 'expired') {
      await e.reply(`⌛【${PLATFORMS[provider].name}】登录二维码已过期，请重新发起登录。`)
      return
    }
    if (session.status === 'failed') {
      await e.reply(`❌【${PLATFORMS[provider].name}】登录失败：${session.message}`)
      return
    }
  }
  if (!task.cancelled) await e.reply(`⌛【${PLATFORMS[provider].name}】登录轮询超时，请重新发送指令。`)
}

function startLoginPolling(e, provider, session) {
  const key = `${provider}:${e.user_id || e.sender?.user_id || 'unknown'}`
  const previous = loginTasks.get(key)
  if (previous) previous.cancelled = true
  const task = { cancelled: false }
  loginTasks.set(key, task)
  pollLogin(e, provider, session, task)
    .catch(async err => {
      logger.warn(`[MusicUID] ${provider} 登录轮询中止：${err.message}`)
      try { await e.reply(`❌【${PLATFORMS[provider].name}】登录轮询中止：${err.message}`) } catch { /* The original reply context may have expired. */ }
    })
    .finally(() => { if (loginTasks.get(key) === task) loginTasks.delete(key) })
}

async function autoRefreshQqCredential() {
  const credential = loadQqCredential()
  if (!credential || !qqCredentialExpiring(credential)) return
  const result = await refreshQqCredential()
  if (!result.ok) logger.warn(`[MusicUID] QQ 音乐定时自动续期失败：${result.message}`)
}

if (global.__MusicUIDRefreshTimer) clearInterval(global.__MusicUIDRefreshTimer)
global.__MusicUIDRefreshTimer = setInterval(() => {
  autoRefreshQqCredential().catch(err => logger.warn(`[MusicUID] QQ 音乐自动续期异常：${err.message}`))
}, 12 * 60 * 60 * 1000)
global.__MusicUIDRefreshTimer.unref?.()

try {
  fs.mkdirSync(TEMP_DIR, { recursive: true })
  for (const name of fs.readdirSync(TEMP_DIR)) {
    const filePath = path.join(TEMP_DIR, name)
    if (fs.statSync(filePath).mtimeMs < Date.now() - 24 * 60 * 60 * 1000) fs.rmSync(filePath, { force: true })
  }
} catch (err) {
  logger.debug(`[MusicUID] 清理旧临时文件失败：${err.message}`)
}

function md5(value) {
  return createHash('md5').update(value).digest('hex')
}

async function kugouLoggedPlayUrl(song) {
  const cookie = config.kugouCookie || ''
  const token = cookie.match(/(?:^|;\s*)(?:t|token)=([^;]*)/i)?.[1]
  const userId = cookie.match(/(?:^|;\s*)(?:KugooID|userid)=([^;]*)/i)?.[1]
  if (!token || !userId) return ''
  const mid = BigInt(`0x${md5('MusicUID')}`).toString()
  const dfid = Array.from({ length: 24 }, () => '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'[randomInt(36)]).join('')
  const clienttime = Math.floor(Date.now() / 1000)
  const candidates = [{ hash: song.songId, albumId: song.albumId, albumAudioId: song.albumAudioId }, ...(song.kugouVariants || [])]
  const seen = new Set()
  for (const candidate of candidates) {
    const hash = cleanText(candidate.hash || song.songId).toLowerCase()
    if (!/^[\da-f]{32}$/.test(hash)) continue
    const albumId = Number(candidate.albumId) || 0
    const albumAudioId = Number(candidate.albumAudioId) || 0
    const candidateKey = `${hash}:${albumId}:${albumAudioId}`
    if (seen.has(candidateKey)) continue
    seen.add(candidateKey)
    const params = {
      album_id: albumId, area_code: 1, hash, ssa_flag: 'is_fromtrack', version: 11430,
      page_id: 151369488, quality: 128, album_audio_id: albumAudioId, behavior: 'play', pid: 2,
      cmd: 26, pidversion: 3001, IsFreePart: 0, ppage_id: '463467626,350369493,788954147',
      cdnBackup: 1, module: '', clientver: 11430, dfid, mid, uuid: '-', appid: KUGOU_MUSIC_APPID,
      clienttime, token, userid: userId,
    }
    params.key = md5(`${hash}57ae12eb6890223e355ccfcb74edf70d${params.appid}${mid}${userId}`)
    const signed = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('')
    params.signature = md5(`OIlwieks28dk2k092lksi2UIkp${signed}OIlwieks28dk2k092lksi2UIkp`)
    try {
      const data = await requestJson(queryUrl('https://gateway.kugou.com/v5/url', params), {
        headers: {
          'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
          'x-router': 'trackercdn.kugou.com', dfid, mid, clienttime: String(clienttime), Cookie: cookie,
          'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
        },
      })
      const url = Array.isArray(data?.url)
        ? data.url.find(value => typeof value === 'string' && value) || ''
        : typeof data?.url === 'string' ? data.url : ''
      if (url) return url
      logger.info(`[MusicUID] 酷狗网关未下发 ${song.name}：status=${data?.status} err=${data?.error_code} hash=${hash.slice(0, 8)} album_id=${albumId} album_audio_id=${albumAudioId}`)
    } catch (err) {
      logger.info(`[MusicUID] 酷狗登录态取流失败（${hash.slice(0, 8)}）：${err.message}`)
    }
  }
  return ''
}

const WEAPI_MODULUS = BigInt('0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7')
const WEAPI_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function modPow(base, exponent, modulus) {
  let result = 1n
  let factor = base % modulus
  let power = exponent
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus
    factor = (factor * factor) % modulus
    power >>= 1n
  }
  return result
}

function aesWeapi(text, key) {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from('0102030405060708', 'utf8'))
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64')
}

function weapiForm(payload) {
  const secret = Array.from({ length: 16 }, () => WEAPI_CHARS[randomInt(WEAPI_CHARS.length)]).join('')
  const inner = aesWeapi(JSON.stringify(payload), '0CoJUm6Qyw8W8jud')
  const params = aesWeapi(inner, secret)
  const reversed = Buffer.from(secret.split('').reverse().join(''), 'utf8').toString('hex')
  const encSecKey = modPow(BigInt(`0x${reversed}`), 65537n, WEAPI_MODULUS).toString(16).padStart(256, '0')
  return { params, encSecKey }
}

async function neteaseWeapiPlay(song, preferMp3 = true) {
  if (!config.neteaseCookie) return ''
  const requested = ['standard', 'exhigh', 'lossless'].includes(config.neteaseLevel) ? config.neteaseLevel : 'exhigh'
  const levels = requested === 'standard' ? ['standard'] : [requested, 'standard']
  for (const level of levels) {
    const form = new URLSearchParams(weapiForm({
      ids: `[${song.songId}]`, level, encodeType: preferMp3 ? 'mp3' : 'flac', csrf_token: '',
    }))
    try {
      const data = await requestJson('https://music.163.com/weapi/song/enhance/player/url/v1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://music.163.com/',
          Cookie: /(?:^|;\s*)MUSIC_U=/.test(config.neteaseCookie)
            ? `${config.neteaseCookie}${/\bos=/.test(config.neteaseCookie) ? '' : '; os=pc'}`
            : `MUSIC_U=${config.neteaseCookie}; os=pc`,
        },
        body: form,
      })
      const url = data?.data?.find(item => item?.url)?.url
      if (url) return url
    } catch (err) {
      logger.debug(`[MusicUID] 网易云 ${level} 音质获取失败：${err.message}`)
    }
  }
  return ''
}

function extractUrl(value) {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractUrl(item)
      if (found) return found
    }
  } else if (value && typeof value === 'object') {
    for (const key of ['url', 'play_url', 'playUrl', 'src', 'musicUrl', 'download_url', 'purl']) {
      if (typeof value[key] === 'string' && /^https?:\/\//i.test(value[key])) return value[key]
    }
    for (const key of ['data', 'body', 'req', 'song', 'result', 'songs', 'list']) {
      if (value[key] && typeof value[key] === 'object') {
        const found = extractUrl(value[key])
        if (found) return found
      }
    }
  }
  return ''
}

function customTargets(song) {
  const base = cleanText(config.customApiUrl)
  if (!base) return []
  const values = {
    song_id: song.songId,
    songmid: song.songId,
    id: song.songId,
    platform: song.platform,
    name: song.name,
    artist: song.singers.split('/')[0] || '',
    quality: '320',
  }
  if (base.includes('{') && base.includes('}')) {
    let target = base
    for (const [key, value] of Object.entries(values)) target = target.replaceAll(`{${key}}`, encodeURIComponent(value))
    return /[{}]/.test(target) ? [] : [target]
  }
  const root = base.replace(/\/$/, '')
  if (song.platform === 'qq') return [
    `${root}/song/url?id=${encodeURIComponent(song.songId)}`,
    `${root}/song/url?id=${encodeURIComponent(song.songId)}&type=320`,
    `${root}/api/qq/url?id=${encodeURIComponent(song.songId)}`,
    `${root}/url?platform=qq&id=${encodeURIComponent(song.songId)}`,
  ]
  if (song.platform === 'netease') return [
    `${root}/song/url?id=${encodeURIComponent(song.songId)}`,
    `${root}/song/url?id=${encodeURIComponent(song.songId)}&br=320000`,
    `${root}/api/netease/url?id=${encodeURIComponent(song.songId)}`,
    `${root}/url?platform=netease&id=${encodeURIComponent(song.songId)}`,
  ]
  return [
    `${root}/song/url?id=${encodeURIComponent(song.songId)}&platform=kugou`,
    `${root}/url?platform=kugou&id=${encodeURIComponent(song.songId)}`,
  ]
}

async function resolveCustom(song) {
  const headers = { Accept: 'application/json, audio/*, */*' }
  if (config.customApiToken) {
    headers.Authorization = /^bearer\s/i.test(config.customApiToken)
      ? config.customApiToken
      : `Bearer ${config.customApiToken}`
    headers['X-API-Key'] = config.customApiToken
    headers.Token = config.customApiToken
  }
  for (const target of customTargets(song)) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      let response
      try {
        response = await fetch(target, { headers, signal: controller.signal, redirect: 'follow' })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) continue
      const contentType = response.headers.get('content-type') || ''
      if (/audio\/|application\/octet-stream/i.test(contentType)) return response.url || target
      const result = extractUrl(await response.json())
      if (result) return result
    } catch { /* Try the next compatible route. */ }
  }
  return ''
}

async function playUrl(song, preferMp3 = true) {
  if (config.customApiPriority === 'first') {
    const custom = await resolveCustom(song)
    if (custom) return custom
  }

  if (song.platform === 'netease') {
    const official = await neteaseWeapiPlay(song, preferMp3)
    if (official) return official
    const url = queryUrl('https://music.163.com/song/media/outer/url', { id: `${song.songId}.mp3` })
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      let target = url
      try {
        for (let hop = 0; hop < 6; hop++) {
          const response = await fetch(target, {
            redirect: 'manual', signal: controller.signal,
            headers: {
              Referer: 'https://music.163.com/',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
            },
          })
          const location = response.headers.get('location')
          const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
          await response.body?.cancel().catch(() => {})
          if (isRedirect && location && !/404/i.test(location)) {
            target = new URL(location, target).toString()
            continue
          }
          if (response.ok && !isRedirect) return target
          break
        }
      } finally { clearTimeout(timer) }
    } catch (err) {
      logger.debug(`[MusicUID] 网易云外链探测失败：${err.message}`)
    }
    return resolveCustom(song)
  }

  if (song.platform === 'qq') {
    await ensureQqActiveCookie()
    const cookie = config.qqCookie || ''
    const uin = cookie.match(/(?:^|;\s*)uin=([^;]*)/)?.[1] || '0'
    const formats = preferMp3
      ? [['M800', 'mp3'], ['C400', 'm4a']]
      : [['C400', 'm4a'], ['M800', 'mp3']]
    for (const [prefix, suffix] of formats) {
      const body = {
        req_1: {
          module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
          param: {
            filename: [`${prefix}${song.songId}${song.songId}.${suffix}`], guid: '10000',
            songmid: [song.songId], songtype: [0], uin, loginflag: 1, platform: '20',
          },
        },
        loginUin: uin,
        comm: { uin, format: 'json', ct: 24, cv: 0 },
      }
      try {
        const data = await requestJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', Referer: 'https://y.qq.com/portal/player.html',
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify(body),
        })
        const node = data?.req_1?.data
        const purl = node?.midurlinfo?.[0]?.purl
        const host = node?.sip?.find(Boolean)
        if (purl && host) return `${host}${purl}`
      } catch { /* Try the next quality. */ }
    }
  }

  if (song.platform === 'kugou') {
    const logged = await kugouLoggedPlayUrl(song)
    if (logged) return logged
    const hash = song.songId.toLowerCase()
    const key = md5(`${hash}kgcloudv2`)
    try {
      const data = await requestJson(queryUrl('http://trackercdn.kugou.com/i/v2/', {
        key, hash, br: 'hq', appid: KUGOU_MUSIC_APPID, pid: 2, cmd: 25, behavior: 'play',
      }))
      const url = data?.url?.find(item => typeof item === 'string' && item)
      if (url) return url
    } catch { /* Fall through to configured service. */ }
  }

  return resolveCustom(song)
}

async function lyricNetease(song) {
  const data = await requestJson(queryUrl('https://music.163.com/api/song/lyric', {
    id: song.songId, lv: 1, kv: 1, tv: -1,
  }), { headers: { Referer: 'https://music.163.com/' } })
  return data?.lrc?.lyric || data?.klyric?.lyric || data?.tlyric?.lyric || ''
}

function parseJsonOrJsonp(raw) {
  const text = String(raw ?? '').trim()
  const jsonp = text.match(/^[\w$]+\(([\s\S]*)\)\s*;?$/)
  return JSON.parse(jsonp?.[1] || text)
}

async function lyricQq(song) {
  const raw = await requestText(queryUrl('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
    songmid: song.songId, format: 'json', nobase64: 1, g_tk: 5381, loginUin: 0, hostUin: 0,
    inCharset: 'utf8', outCharset: 'utf-8', notice: 0, platform: 'yqq', needNewCode: 0,
  }), { headers: { Referer: 'https://y.qq.com/portal/player.html' } })
  const data = parseJsonOrJsonp(raw)
  let lyric = String(data?.lyric || data?.data?.lyric || '')
  if (lyric && !lyric.includes('[') && /^[A-Za-z0-9+/=\r\n]+$/.test(lyric)) {
    const decoded = Buffer.from(lyric, 'base64').toString('utf8')
    if (decoded.includes('[') && !decoded.includes('\uFFFD')) lyric = decoded
  }
  return lyric
}

async function lyricKugou(song) {
  const search = await requestJson(queryUrl('https://krcs.kugou.com/search', {
    ver: 1, man: 'yes', client: 'mobi', keyword: song.name,
    duration: Math.round((Number(song.duration) || 0) * 1000), hash: song.songId,
    album_audio_id: song.albumAudioId || '', lrctxt: 1,
  }))
  const candidates = Array.isArray(search?.candidates) ? search.candidates : []
  const candidate = candidates.find(item => String(item.hash || '').toLowerCase() === String(song.songId).toLowerCase()) || candidates[0]
  if (!candidate?.id || !candidate?.accesskey) return ''
  const data = await requestJson(queryUrl('https://lyrics.kugou.com/download', {
    ver: 1, client: 'pc', id: candidate.id, accesskey: candidate.accesskey, fmt: 'lrc', charset: 'utf8',
  }))
  if (!data?.content) return ''
  return Buffer.from(String(data.content), 'base64').toString('utf8')
}

async function lyricForSong(song) {
  if (song.platform === 'qq') return lyricQq(song)
  if (song.platform === 'kugou') return lyricKugou(song)
  return lyricNetease(song)
}

function formatSong(song, index) {
  const duration = durationText(song.duration)
  const suffix = duration ? ` · ${duration}` : ''
  return `${index}. [${PLATFORMS[song.platform]?.name || song.platform}] ${song.name} - ${song.singers}${suffix}`
}

function getCoreInfo() {
  let metadata = {}
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
  } catch { /* Use the generic name when the bot package metadata is unavailable. */ }
  const packageName = String(metadata.name || '').toLowerCase()
  const name = packageName.includes('trss-yunzai') ? 'TRSS-Yunzai'
    : packageName.includes('miao-yunzai') ? 'Miao-Yunzai'
      : packageName.includes('yunzai-bot') ? 'Yunzai-Bot'
        : 'Yunzai'
  const version = String(metadata.version || global.Bot?.version || global.Bot?.Version || global.Version || '').trim()
  return `${name}${version ? ` ${version}` : ''}`
}

async function sendCard(e, template, data) {
  if (!config.renderCard || !e.runtime?.render) return false
  const preferredScale = Math.min(3, Math.max(1, Number(config.renderScale) || 1))
  const preferredType = config.renderImageType === 'jpeg' ? 'jpeg' : 'png'
  const attempts = [{ scale: preferredScale, type: preferredType }]
  if (preferredScale !== 1 || preferredType !== 'jpeg') attempts.push({ scale: 1, type: 'jpeg' })

  let lastError
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index]
    try {
      const renderData = {
        ...data,
        miSansFont: pathToFileURL(FONT_FILE).href,
        coreInfo: getCoreInfo(),
        renderScale: attempt.scale,
        imgType: attempt.type,
      }
      const image = await e.runtime.render(PLUGIN_NAME, template, renderData, { retType: 'base64' })
      if (!image) throw new Error('渲染器未返回图片')
      const result = await e.reply(image)
      const failure = replyFailureMessage(result)
      if (failure) throw new Error(failure)
      return true
    } catch (err) {
      lastError = err
      if (index < attempts.length - 1) {
        logger.warn(`[MusicUID] ${template} 图片发送失败，改用 1× JPEG 重试：${err.message}`)
      }
    }
  }
  logger.warn(`[MusicUID] ${template} 图片最终发送失败，改发文本：${lastError?.message || '未知错误'}`)
  return false
}

function rememberCover(url, value, ttl) {
  coverCache.delete(url)
  coverCache.set(url, { value, expiresAt: Date.now() + ttl })
  while (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value)
}

async function getCoverDataUrl(url) {
  const cached = coverCache.get(url)
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      coverCache.delete(url)
      coverCache.set(url, cached)
      return cached.value
    }
    coverCache.delete(url)
  }
  const pending = coverInFlight.get(url)
  if (pending) return pending

  const request = (async () => {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
        signal: AbortSignal.timeout(4000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const mime = (response.headers.get('content-type') || 'image/jpeg').split(';')[0]
      if (!mime.startsWith('image/')) throw new Error('响应不是图片')
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > 2 * 1024 * 1024) throw new Error('封面超过 2 MB')
      const value = `data:${mime};base64,${bytes.toString('base64')}`
      if (bytes.length <= COVER_CACHE_MAX_BYTES) rememberCover(url, value, COVER_CACHE_TTL)
      return value
    } catch {
      rememberCover(url, '', COVER_CACHE_NEGATIVE_TTL)
      return ''
    }
  })().finally(() => coverInFlight.delete(url))
  coverInFlight.set(url, request)
  return request
}

async function inlineCardCovers(groups) {
  const rows = groups.flatMap(group => group.songs).filter(song => /^https?:\/\//i.test(song.cover || ''))
  let cursor = 0
  const worker = async () => {
    while (cursor < rows.length) {
      const song = rows[cursor++]
      song.cover = await getCoverDataUrl(song.cover)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, rows.length) }, worker))
}

async function sendSongList(e, keyword, results) {
  for (const result of results) {
    result.songs = Array.isArray(result.songs) ? result.songs.filter(isUsableSong) : []
  }
  const songs = results.flatMap(result => result.songs)
  if (!songs.length) {
    const errors = results.filter(result => result.error).map(result => `${PLATFORMS[result.platform].name}：${result.error}`)
    await e.reply(`没有搜到「${keyword}」相关歌曲${errors.length ? `\n${errors.join('\n')}` : ''}`)
    return
  }
  saveSession(e, songs, keyword)
  let index = 0
  const groups = results.map(result => ({
    platform: result.platform,
    platform_name: PLATFORMS[result.platform].name,
    playable: true,
    empty_text: result.error || '没有搜到相关歌曲',
    songs: result.songs.map(song => ({
      index: ++index,
      cover: song.coverUrl,
      songName: song.name,
      singerName: song.singers,
      albumName: song.album,
      duration: durationText(song.duration),
      payplay: song.payplay,
    })),
  }))
  const hitNames = results.filter(result => result.songs.length).map(result => PLATFORMS[result.platform].name)
  const errors = results.filter(result => result.error).map(result => `⚠️ ${PLATFORMS[result.platform].name}搜索失败：${result.error}`)
  const cardData = {
    theme: results.length === 1 ? results[0].platform : 'multi',
    eyebrow: results.length === 1 ? `${PLATFORMS[results[0].platform].name} · SEARCH` : '全平台 · SEARCH',
    keyword, total: songs.length,
    subtitle: `${hitNames.join('、')} 共 ${songs.length} 首`,
    groups,
    tip: `发送「听N」播放第 N 首；选中后发送「歌词」取该首歌词，也可用「歌词N」直接查询（列表 10 分钟有效），例如：听1 / 歌词1${errors.length ? `；${errors.join('；')}` : ''}`,
    footer_left: `${hitNames.join('、')} · 数据来自音乐平台`,
  }
  await inlineCardCovers(groups)
  if (await sendCard(e, 'song_list', cardData)) return
  const rows = songs.map((song, index) => formatSong(song, index + 1))
  await e.reply(`🎵「${keyword}」搜索结果\n${rows.join('\n')}\n\n发送「听序号」播放，发送「歌词序号」获取歌词，例如：听1 / 歌词1${errors.length ? `\n${errors.join('；')}` : ''}`)
}

function cloneSongs(songs) {
  return songs.map(song => ({ ...song, kugouVariants: Array.isArray(song.kugouVariants) ? song.kugouVariants.map(item => ({ ...item })) : [] }))
}

function cacheSearchResult(key, result) {
  searchCache.delete(key)
  searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL, songs: cloneSongs(result.songs) })
  while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value)
}

async function searchOne(platform, keyword) {
  const limit = Math.min(10, Math.max(1, Number(config.maxList) || 5))
  const normalizedKeyword = cleanText(keyword).toLocaleLowerCase().replace(/\s+/g, ' ')
  const key = `${platform}:${limit}:${normalizedKeyword}`
  const cached = searchCache.get(key)
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      searchCache.delete(key)
      searchCache.set(key, cached)
      return { platform, songs: cloneSongs(cached.songs), cached: true }
    }
    searchCache.delete(key)
  }

  let pending = searchInFlight.get(key)
  if (!pending) {
    pending = (async () => {
      const songs = await providers[platform].search(keyword, limit)
      cacheSearchResult(key, { songs })
      return { platform, songs }
    })().catch(err => {
      logger.warn(`[MusicUID] ${platform} 搜索失败：${err.message}`)
      return { platform, songs: [], error: err.message }
    }).finally(() => searchInFlight.delete(key))
    searchInFlight.set(key, pending)
  }
  const result = await pending
  return { ...result, songs: cloneSongs(result.songs) }
}

async function probeSearchApis() {
  const checks = [
    {
      name: '网易云音乐', run: async () => {
        const data = await requestJson(queryUrl('https://music.163.com/api/search/get/web', {
          s: '晴天', type: 1, offset: 0, limit: 1, total: 'true',
        }), { timeoutMs: 6000, headers: { Referer: 'https://music.163.com/' } })
        if (!Array.isArray(data?.result?.songs)) throw new Error('响应格式异常')
        return data.result.songs.length
      },
    },
    {
      name: 'QQ 音乐', run: async () => {
        const body = {
          comm: { ct: '19', cv: '1859', uin: '0' },
          req: {
            method: 'DoSearchForQQMusicDesktop', module: 'music.search.SearchCgiService',
            param: { grp: 1, num_per_page: 1, page_num: 1, query: '晴天', search_type: 0 },
          },
        }
        const data = await requestJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
          method: 'POST', timeoutMs: 6000,
          headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/portal/player.html' },
          body: JSON.stringify(body),
        })
        const songs = data?.req?.data?.body?.song?.list
        if (!Array.isArray(songs)) throw new Error('响应格式异常')
        return songs.length
      },
    },
    {
      name: '酷狗音乐', run: async () => {
        const data = await requestJson(queryUrl('https://mobiles.kugou.com/api/v3/search/song', {
          format: 'json', keyword: '晴天', page: 1, pagesize: 1, showtype: 1,
        }), { timeoutMs: 6000 })
        const songs = data?.data?.info
        if (!Array.isArray(songs)) throw new Error('响应格式异常')
        return songs.length
      },
    },
  ]
  return Promise.all(checks.map(async check => {
    const started = Date.now()
    try {
      const count = await check.run()
      return { name: check.name, ok: true, elapsed: Date.now() - started, count }
    } catch (err) {
      const reason = err.name === 'AbortError' || err.name === 'TimeoutError'
        ? '请求超时' : err.message.match(/HTTP \d+/)?.[0] || '响应异常'
      return { name: check.name, ok: false, elapsed: Date.now() - started, error: reason }
    }
  }))
}

function safeAudioName(song, extension = 'mp3') {
  const base = `${song.name}${song.singers ? ` - ${song.singers}` : ''}`
    .replace(/[<>:"/\\|?*\r\n\t]/g, '_').slice(0, 60).trim() || 'music'
  return `${base}.${extension}`
}

function replyFailureMessage(result, expectedParts = 1) {
  if (result === false) return '适配器未接受消息'
  if (result instanceof Error) return result.message || '适配器发送失败'
  if (!result || typeof result !== 'object') return ''

  // wind-trace QQBot returns { message_id, data, error }. Its error array can
  // retain an earlier failed attempt even when a later adapter retry succeeds.
  if (Array.isArray(result.data) && Array.isArray(result.error) && Array.isArray(result.message_id)) {
    if (result.data.length >= expectedParts) return ''
    if (result.error.length === 0) return result.data.length ? '' : '适配器未返回发送结果'
    const lastError = result.error.at(-1)
    const message = cleanText(lastError?.wording || lastError?.message || lastError?.error?.message || lastError)
    return message || '适配器发送失败'
  }

  const nodes = [result, result.error, result.data, result.data?.error].filter(value => value && typeof value === 'object')
  for (const node of nodes) {
    const failed = node.status === 'failed' || node.status === 'error'
      || (node.retcode !== undefined && Number(node.retcode) !== 0)
      || (Array.isArray(node.error) ? node.error.length > 0 : Boolean(node.error))
    const message = cleanText(node.wording || node.message || node.error?.message || result.wording || result.message)
    if (failed || /(?:转换|发送).{0,8}失败|拒绝发送/i.test(message)) return message || '适配器拒绝发送'
  }
  return ''
}

function normalizeAudioUrl(value) {
  let url = cleanText(value).replace(/&amp;/gi, '&').replace(/\\\//g, '/')
  const markdown = url.match(/^\[https?:\/\/[^\]]+\]\((https?:\/\/[^)]+)\)$/i)
  if (markdown) url = markdown[1]
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

async function deliverAudio(e, song, url) {
  url = normalizeAudioUrl(url)
  if (!url) {
    await e.reply(`《${song.name}》获取到的音源地址无效，请重新搜索或换个平台。`)
    return false
  }
  const sent = []
  const failures = []
  const profile = audioDeliveryProfile(e)
  if (config.sendVoice) {
    try {
      if (!global.segment?.record) throw new Error('当前 Yunzai 未提供 segment.record')
      const result = await e.reply(global.segment.record(url))
      const failure = replyFailureMessage(result)
      if (failure) throw new Error(failure)
      sent.push(`${profile.adapter} ${profile.preferMp3 ? 'MP3优先' : '原格式优先'}语音`)
    } catch (err) {
      logger.warn(`[MusicUID] 语音发送失败：${err.message}`)
      failures.push(`语音发送失败：${err.message}`)
    }
  }
  if (config.sendFile) {
    try {
      if (!global.segment?.file) throw new Error('当前 Yunzai 未提供 segment.file')
      const result = await e.reply(global.segment.file(url, safeAudioName(song)))
      const failure = replyFailureMessage(result)
      if (failure) throw new Error(failure)
      sent.push('文件')
    } catch (err) {
      logger.warn(`[MusicUID] 音频文件发送失败：${err.message}`)
      failures.push(`文件发送失败：${err.message}`)
    }
  }
  if (!config.sendVoice && !config.sendFile) failures.push('语音和文件发送都已关闭')

  if (!sent.length) {
    const failure = failures.join('；') || '适配器未发送音频'
    logger.warn(`[MusicUID] 直链音频发送失败：${failure}`)
    const durationLimit = /40093013|时长超过限制|语音.{0,8}时长/i.test(failure)
    await e.reply(isQQBotVoiceAdapter(e) && durationLimit
      ? 'QQBot 拒绝发送：这首歌超过平台语音时长限制。'
      : `音频发送失败：${failure}`)
    return false
  }
  logger.info(`[MusicUID] 已下发 ${song.platform} 歌曲《${song.name}》，适配器：${profile.adapter}，方式：${sent.join('、')}`)
  return true
}

async function deliver(e, song) {
  if (!isUsableSong(song)) {
    logger.warn('[MusicUID] 拒绝播放无效歌曲对象；请重新搜索歌曲列表')
    await e.reply('这首歌的信息已失效，请重新发送「点歌 歌名」后再选择序号。')
    return false
  }
  const profile = audioDeliveryProfile(e)
  let url
  try {
    url = await playUrl(song, profile.preferMp3)
  } catch (err) {
    logger.warn(`[MusicUID] 获取播放地址失败：${err.message}`)
  }
  if (!url) {
    await e.reply(song.payplay
      ? `《${song.name}》需要 ${PLATFORMS[song.platform]?.name || '对应平台'} 会员或购买该专辑才能播放。`
      : `《${song.name}》暂时获取不到音源，可以换个平台或配置自建音源 API。`)
    return
  }
  await deliverAudio(e, song, url)
}

function isOwner(e) {
  return Boolean(e.isMaster || e.isMaster === true)
}

export class MusicUID extends plugin {
  constructor() {
    super({
      name: 'MusicUID',
      dsc: '网易云 / QQ音乐 / 酷狗点歌',
      event: 'message',
      priority: 300,
      rule: withCommandPrefixes([
        { reg: '^(?:点歌帮助|听歌帮助|点歌菜单|音乐菜单|点歌help|音乐help)$', fnc: 'help' },
        { reg: '^(?:点歌诊断|点歌检查|音乐诊断)$', fnc: 'diagnose' },
        { reg: '^(?:点歌状态|点歌登录状态|音乐状态|音乐登录状态)$', fnc: 'status' },
        { reg: '.*点歌\\s*(?:加白|添加白名单|白名单添加|删白|删除白名单|白名单删除)\\s*.*$', fnc: 'whitelist' },
        { reg: '^(?:点歌\\s*)?(?:点歌白名单|白名单|白名单列表|音乐白名单)$', fnc: 'whitelist' },
        { reg: '^(?:设置自建api|自建api|配置自建api|自建音源|设置自建音源)(?:\\s+.*)?$', fnc: 'setApi' },
        { reg: '^(?:自建api模式|自建音源模式|音源模式)(?:\\s+.*)?$', fnc: 'setApiMode' },
        { reg: '^(?:测试自建api|测试自建音源|测试自建)$', fnc: 'testApi' },
        { reg: '^(?:[Qq][Qq]音乐刷新|[Qq][Qq]刷新|点歌刷新 [Qq][Qq]|刷新[Qq][Qq]音乐|点歌刷新[Qq][Qq])$', fnc: 'refreshQq' },
        { reg: '^(?:[Qq][Qq]音乐cookie|[Qq][Qq]cookie|[Qq][Qq]_cookie|网易云cookie|网易cookie|酷狗cookie|设置cookie|导入cookie|点歌\\s+(?:设置cookie|导入cookie|cookie|绑定)|点歌设置cookie|点歌导入cookie|点歌cookie|点歌绑定)(?:\\s+.*)?$', fnc: 'cookie' },
        { reg: '^(?:点歌登录|音乐登录|网易云\\s*登录|网易\\s*登录|酷狗\\s*登录|[Qq][Qq]\\s*登录|[Qq][Qq]音乐\\s*登录|扫码登录)(?:\\s+.*)?$', fnc: 'login' },
        { reg: '^(?:点歌|搜歌|搜索歌曲)(?:\\s+.*)?$', fnc: 'search' },
        { reg: '^(?:播放|点播)\\s*(.*)$', fnc: 'play' },
        { reg: '^听\\s*(\\d+)$', fnc: 'pick' },
        { reg: '^歌词\\s*(.*)$', fnc: 'lyric' },
        { reg: '.*', fnc: 'resolveLink', log: false },
      ]),
    })
  }

  async help(e) {
    const text = [
      '🎵 MusicUID 点歌帮助',
      '点歌 晴天：网易云音乐、QQ音乐、酷狗音乐并发搜索',
      '点歌 QQ 晴天：指定平台搜索（网易云音乐 / QQ音乐 / 酷狗音乐）',
      '播放 晴天：搜索后直接播放第一首',
      '听1：播放最近一次搜索结果中的第 1 首（10 分钟有效）；随后发送「歌词」可取该首歌词',
      '歌词1：获取最近一次搜索列表第 1 首对应平台的歌词',
      '歌词 QQ 晴天 / 歌词 酷狗 晴天：查询指定平台歌词',
      '网易云登录 / 点歌登录 网易云：使用网易云音乐 APP 扫码并自动保存登录凭据',
      '酷狗登录 / 点歌登录 酷狗：手机酷狗音乐扫码登录；QQ登录：手机扫码并自动续期',
      '网易云cookie <MUSIC_U值>、QQ音乐cookie <Cookie值>：也可手动导入平台凭据',
      '设置cookie 平台 <Cookie值>：通用凭据导入；支持网易云音乐、QQ音乐、酷狗音乐',
      '点歌状态 / 点歌登录状态：查看平台凭据；点歌加白、点歌删白、点歌白名单：管理登录授权',
      '点歌诊断：检查适配器能力、登录凭据概况和三个平台搜索接口',
      '发送网易云、QQ音乐或酷狗歌曲/歌单分享链接：解析歌曲并播放，歌单生成可选播列表',
      '网页控制台配置：在 Guoba-Plugin 插件配置页调整默认平台、列表数量、音频投递和链接解析',
      '设置自建api <URL>、自建api模式 fallback|first、测试自建api：配置与检测兜底音源',
    ].join('\n')
    const sections = [
      { type: 'search', title: '点歌搜索与播放', commands: [
        { cmd: '点歌 关键词', desc: '搜索并列出多平台匹配歌曲', tag: '搜索' },
        { cmd: '点歌 QQ 关键词', desc: '临时指定网易云音乐、QQ音乐或酷狗音乐搜索', tag: '平台' },
        { cmd: '播放 关键词', desc: '搜索并直接播放第一首匹配歌曲', tag: '播放' },
        { cmd: '听N', desc: '播放当前搜索列表第 N 首歌曲', tag: '选播' },
        { cmd: '歌词N', desc: '获取当前搜索列表第 N 首对应平台的歌词', tag: '歌词' },
        { cmd: '歌词', desc: '获取最近一次「听N」选中歌曲对应平台的歌词', tag: '歌词' },
        { cmd: '歌词 平台 关键词', desc: '搜索并展示指定平台歌曲的歌词', tag: '歌词' },
      ] },
      { type: 'login', title: '扫码登录与凭证管理', commands: [
        { cmd: '网易云登录 / 点歌登录 网易云', desc: '使用网易云音乐 APP 扫码登录并自动保存凭据', tag: '扫码登录' },
        { cmd: '酷狗登录 / 点歌登录 酷狗', desc: '使用手机酷狗扫码登录并获取会员音源', tag: '扫码登录' },
        { cmd: '网易云cookie <MUSIC_U值>', desc: '快捷导入网易云音乐登录 Cookie', tag: '快捷导入' },
        { cmd: 'QQ音乐cookie <Cookie值>', desc: '导入 QQ 音乐 Cookie；也可扫码登录', tag: '快捷配置' },
        { cmd: '设置cookie 平台 <Cookie值>', desc: '手动绑定网易云音乐、QQ音乐或酷狗音乐凭据', tag: '通用配置' },
        { cmd: '点歌状态 / 点歌登录状态', desc: '查看三个平台的凭据绑定状态', tag: '状态查询' },
        { cmd: '点歌加白 <用户ID/@用户>', desc: '授权用户使用登录与凭据管理', tag: '主人权限' },
        { cmd: '点歌删白 <用户ID/@用户>', desc: '从登录白名单中移除用户', tag: '主人权限' },
        { cmd: '点歌白名单', desc: '查看已获授权的白名单用户', tag: '白名单' },
      ] },
      { type: 'link', title: '链接解析与配置', commands: [
        { cmd: '发送音乐分享链接', desc: '自动解析网易云音乐、QQ音乐、酷狗音乐单曲和歌单', tag: '自动解析' },
        { cmd: '网页控制台配置', desc: '在 Guoba 插件配置页设置默认平台、列表与投递选项', tag: '锅巴配置' },
        { cmd: '点歌诊断', desc: '检查适配器、凭据概况和平台搜索接口连接', tag: '诊断' },
      ] },
    ]
    if (await sendCard(e, 'help', { sections })) return true
    await e.reply(text)
    return true
  }

  async search(e) {
    const query = textOf(e).replace(/^(点歌|搜歌|搜索歌曲)\s*/i, '').trim()
    if (/^(?:帮助|help|菜单|menu)$/i.test(query)) return this.help(e)
    if (/^(?:状态|登录状态|status)$/i.test(query)) return this.status(e)
    if (/^(?:白名单|白名单列表)$/i.test(query)) {
      return this.whitelist(routedEvent(e, '点歌白名单'))
    }
    if (/^(?:加白|添加白名单|白名单添加|删白|删除白名单|白名单删除)(?:\s|$)/i.test(query)) {
      const removing = /^(?:删白|删除白名单|白名单删除)/i.test(query)
      const remainder = query.replace(/^(?:加白|添加白名单|白名单添加|删白|删除白名单|白名单删除)\s*/i, '')
      const routedText = (removing ? '点歌删白 ' : '点歌加白 ') + remainder
      return this.whitelist(routedEvent(e, routedText))
    }
    if (/^(?:登录|login)(?:\s|$)/i.test(query)) {
      const routedText = ('点歌登录 ' + query.replace(/^(?:登录|login)\s*/i, '')).trim()
      return this.login(routedEvent(e, routedText))
    }
    if (/^(?:设置cookie|导入cookie|cookie|绑定)(?:\s|$)/i.test(query)) {
      const routedText = '点歌' + query
      return this.cookie(routedEvent(e, routedText))
    }
    const { platform, keyword } = parsePlatformAndKeyword(query)
    if (!keyword) return e.reply('请输入歌名，例如：点歌 晴天；也可指定平台：点歌 QQ 晴天')
    const platforms = platform ? [platform] : SEARCH_ORDER
    const results = await Promise.all(platforms.map(item => searchOne(item, keyword)))
    await sendSongList(e, keyword, results)
    return true
  }

  async play(e) {
    const { platform, keyword } = parsePlatformAndKeyword(textOf(e).replace(/^(?:播放|点播)\s*/i, ''), config.defaultPlatform)
    if (!keyword) return e.reply('请输入歌名，例如：播放 晴天')
    const result = await searchOne(platform || 'netease', keyword)
    if (!result.songs.length) return e.reply(`没有搜到「${keyword}」相关歌曲`)
    saveSession(e, result.songs, keyword).selectedSongIndex = 1
    await deliver(e, result.songs[0])
    return true
  }

  async pick(e) {
    const index = Number(textOf(e).match(/^听\s*(\d+)$/)?.[1])
    const session = sessions.get(eventKey(e))
    if (!session || session.expires < Date.now() || !Array.isArray(session.songs)) {
      sessions.delete(eventKey(e))
      await e.reply('当前没有有效的歌曲列表，请先发送「点歌 歌名」。')
      return true
    }
    if (index < 1 || index > session.songs.length) {
      await e.reply(`序号超出范围，当前列表共 ${session.songs.length} 首。`)
      return true
    }
    if (!isUsableSong(session.songs[index - 1])) {
      logger.warn(`[MusicUID] 搜索会话第 ${index} 项无效，会话共 ${session.songs.length} 项`)
      await e.reply('该序号的歌曲信息已失效，请重新发送「点歌 歌名」后再选择。')
      return true
    }
    session.selectedSongIndex = index
    await deliver(e, session.songs[index - 1])
    return true
  }

  async lyric(e) {
    const query = textOf(e).replace(/^歌词\s*/i, '').trim()
    const indexMatch = query.match(/^(\d+)$/)
    let selectedSong = null
    let lyricSong = null
    if (indexMatch || !query) {
      const session = sessions.get(eventKey(e))
      if (!session || session.expires < Date.now() || !Array.isArray(session.songs)) {
        sessions.delete(eventKey(e))
        return e.reply('当前没有有效的歌曲列表，请先发送「点歌 歌名」。')
      }
      const index = indexMatch ? Number(indexMatch[1]) : Number(session.selectedSongIndex)
      if (!index) return e.reply('请先发送「听N」选中歌曲，再发送「歌词」；也可直接发送「歌词N」。')
      if (index < 1 || index > session.songs.length) return e.reply(`序号超出范围，当前列表共 ${session.songs.length} 首。`)
      selectedSong = session.songs[index - 1]
      if (!isUsableSong(selectedSong)) return e.reply('该序号的歌曲信息已失效，请重新发送「点歌 歌名」。')
      lyricSong = selectedSong
    } else {
      const { platform, keyword } = parsePlatformAndKeyword(query, 'netease')
      if (!keyword) return e.reply('请输入歌名，例如：歌词 晴天；也可使用「听N」后发送「歌词」。')
      const result = await searchOne(platform || 'netease', keyword)
      if (!result.songs.length) return e.reply(`没有搜到「${keyword}」相关歌曲`)
      lyricSong = result.songs[0]
    }

    try {
      const lyrics = await lyricForSong(lyricSong)
      const displaySong = selectedSong || lyricSong
      if (!lyrics.trim()) return e.reply(`《${displaySong.name}》暂无歌词。`)
      await e.reply(`🎵 ${displaySong.name} - ${displaySong.singers}\n\n${lyrics}`)
    } catch (err) {
      await e.reply(`歌词查询失败：${err.message}`)
    }
    return true
  }

  async diagnose(e) {
    if (!isLoginAuthorized(e)) return e.reply('❌ 权限不足：仅主人及登录白名单用户可查看诊断信息。')
    const profile = audioDeliveryProfile(e)
    const credential = loadQqCredential()
    const leftDays = credential
      ? (Number(credential.musickey_create_time) + Number(credential.key_expires_in) - Date.now() / 1000) / 86400
      : 0
    const qqState = credential
      ? leftDays > 0 ? `移动凭据已配置，约剩余 ${leftDays.toFixed(1)} 天` : '移动凭据已配置，可能已过期'
      : config.qqCookie ? '普通 Cookie 已配置' : '未配置'
    const voiceState = !config.sendVoice ? '已关闭'
      : profile.canSendVoice ? '已启用，segment.record 可用' : '已启用，但当前环境没有 segment.record'
    const fileState = !config.sendFile ? '已关闭'
      : profile.canSendFile ? '已启用，segment.file 可用' : '已启用，但当前环境没有 segment.file'
    const cardState = !config.renderCard ? '已关闭'
      : typeof e.runtime?.render === 'function' ? `已启用，渲染器可用（${config.renderScale}× ${config.renderImageType}）`
        : '已启用，但当前事件没有图片渲染器'
    const apiResults = await probeSearchApis()
    const capabilities = [
      { label: '当前适配器', value: profile.adapter, state: 'ok' },
      { label: '语音发送', value: voiceState, state: config.sendVoice && !profile.canSendVoice ? 'warn' : 'ok' },
      { label: '音源格式', value: profile.preferMp3 ? 'MP3 音源优先' : '平台默认格式优先', state: 'info' },
      { label: '文件发送', value: fileState, state: config.sendFile && !profile.canSendFile ? 'warn' : 'info' },
      { label: '图片卡片', value: cardState, state: config.renderCard && typeof e.runtime?.render !== 'function' ? 'warn' : 'ok' },
    ]
    const credentials = [
      { name: '网易云音乐', value: config.neteaseCookie ? '已配置登录凭据' : '未配置', state: config.neteaseCookie ? 'ok' : 'off' },
      { name: 'QQ 音乐', value: qqState, state: credential ? (leftDays > 0 ? 'ok' : 'warn') : config.qqCookie ? 'ok' : 'off' },
      { name: '酷狗音乐', value: config.kugouCookie ? '已配置登录凭据' : '未配置', state: config.kugouCookie ? 'ok' : 'off' },
      { name: '自建音源', value: config.customApiUrl ? (config.customApiPriority === 'first' ? '已配置 · 优先调用' : '已配置 · 兜底') : '未配置', state: config.customApiUrl ? 'ok' : 'off' },
    ].map(item => ({
      ...item,
      mark: item.state === 'ok' ? '✓' : item.state === 'warn' ? '!' : '·',
      stateLabel: item.state === 'ok' ? '已配置' : item.state === 'warn' ? '需检查' : '未配置',
    }))
    const apiLines = apiResults.map(result => result.ok
      ? `✅ ${result.name}搜索接口：可用（${result.elapsed} ms，测试结果 ${result.count} 首）`
      : `❌ ${result.name}搜索接口：${result.error}（${result.elapsed} ms）`)
    const report = [
      '【MusicUID 点歌诊断】',
      `适配器：${profile.adapter}`,
      `语音：${voiceState}；${profile.preferMp3 ? 'MP3 音源优先' : '平台默认音源优先'}`,
      `文件：${fileState}`,
      `图片卡片：${cardState}`,
      `凭据：网易云 ${config.neteaseCookie ? '已配置' : '未配置'}；QQ 音乐 ${qqState}；酷狗 ${config.kugouCookie ? '已配置' : '未配置'}`,
      `自建音源：${config.customApiUrl ? `已配置（${config.customApiPriority === 'first' ? '优先调用' : '兜底'}）` : '未配置'}`,
      `缓存：搜索 ${searchCache.size} 项，封面 ${coverCache.size} 项`,
      '搜索接口探测（不使用或显示 Cookie）：',
      ...apiLines,
      '说明：接口探测只检查搜索服务连通性，不验证会员权益或具体歌曲播放地址。',
    ].join('\n')
    const cardData = {
      adapter: profile.adapter,
      capabilities,
      credentials,
      apiResults: apiResults.map(result => ({
        ...result,
        value: result.ok ? `${result.elapsed} ms · ${result.count} 首` : `${result.error} · ${result.elapsed} ms`,
        state: result.ok ? 'ok' : 'warn',
        mark: result.ok ? '✓' : '!',
        stateLabel: result.ok ? '可用' : '异常',
      })),
      cacheSummary: `搜索 ${searchCache.size} 项 · 封面 ${coverCache.size} 项`,
    }
    if (await sendCard(e, 'diagnostic', cardData)) return true
    return e.reply(report)
  }

  async status(e) {
    if (!isLoginAuthorized(e)) return e.reply('❌ 权限不足：仅主人及登录白名单用户可查看凭据状态。')
    const credential = loadQqCredential()
    const leftDays = credential
      ? Math.max(0, (Number(credential.musickey_create_time) + Number(credential.key_expires_in) - Date.now() / 1000) / 86400)
      : 0
    const platforms = [
      {
        key: 'netease', icon: '☁️', name: '网易云音乐', state: config.neteaseCookie ? 'ok' : 'off',
        icon_url: pathToFileURL(path.join(PLUGIN_DIR, 'resources', 'images', 'status-netease.jpg')).href,
        state_text: config.neteaseCookie ? '已绑定' : '未配置', value: maskSecret(config.neteaseCookie),
        note: config.neteaseCookie ? 'weapi 登录态音源可用' : '发送「网易云登录」手机扫码绑定',
      },
      {
        key: 'qq', icon: '♫', name: 'QQ 音乐', state: credential ? 'ok' : config.qqCookie ? 'warn' : 'off',
        icon_url: pathToFileURL(path.join(PLUGIN_DIR, 'resources', 'images', 'status-qqmusic.jpg')).href,
        state_text: credential ? '长效续期' : config.qqCookie ? '普通 Cookie' : '未配置',
        value: credential ? `移动协议账号：${credential.nick || credential.musicid}` : maskSecret(config.qqCookie),
        note: credential ? `凭据剩余约 ${leftDays.toFixed(1)} 天，后台每 12 小时自动巡检` : '发送「QQ登录」扫码绑定',
      },
      {
        key: 'kugou', icon: '🐾', name: '酷狗音乐', state: config.kugouCookie ? 'ok' : 'off',
        icon_url: pathToFileURL(path.join(PLUGIN_DIR, 'resources', 'images', 'status-kugou.jpg')).href,
        state_text: config.kugouCookie ? '已绑定' : '未配置', value: maskSecret(config.kugouCookie),
        note: config.kugouCookie ? '登录态可尝试会员试听' : '发送「酷狗登录」手机扫码绑定',
      },
      {
        key: 'custom', icon: '🌐', name: '自建 / 第三方音源', state: config.customApiUrl ? 'ok' : 'off',
        state_text: config.customApiUrl ? '已启用' : '未配置', value: config.customApiUrl || '未绑定外部音源服务',
        note: `调度模式：${config.customApiPriority === 'first' ? '优先自建' : '官方优先 · 自建兜底'}`,
      },
    ]
    const bound = platforms.filter(platform => platform.state !== 'off').length
    const data = {
      summary: `共 ${platforms.length} 项音源 · 已绑定 ${bound} 项凭据`,
      platforms,
      tips: [
        { label: '扫码登录', text: '发送「网易云登录」「QQ登录」或「酷狗登录」扫码绑定' },
        { label: '网易云', text: '也支持发送「网易云cookie <MUSIC_U>」手动导入' },
        { label: '自建服务', text: '发送「设置自建api <URL>」或「测试自建api」' },
      ],
    }
    const fallback = [
      '【MusicUID 音乐平台凭据与音源状态】',
      ...platforms.map(platform => `• ${platform.icon} ${platform.name}: ${platform.value}\n  ${platform.note}`),
      '', '网易云 / QQ / 酷狗均支持扫码登录；也可手动导入 Cookie；自建服务用「设置自建api <URL>」。',
    ].join('\n')
    if (!(await sendCard(e, 'status', data))) await e.reply(fallback)
    return true
  }

  async setApi(e) {
    if (!isLoginAuthorized(e)) return e.reply('❌ 权限不足：仅主人及登录白名单用户可配置音源 API。')
    const raw = textOf(e).replace(/^(?:设置自建api|自建api|配置自建api|自建音源|设置自建音源)\s*/i, '').trim()
    if (!raw) return e.reply(`【自建音源 API】\n当前地址：${config.customApiUrl || '未配置'}\n设置：设置自建api http://127.0.0.1:3300\n清空：设置自建api 清空\n检测：测试自建api`)
    config.customApiUrl = /^(?:清空|clear|none|删除)$/i.test(raw) ? '' : raw
    saveConfig()
    return e.reply(config.customApiUrl
      ? `✅ 已更新自建音源地址：${config.customApiUrl}\n建议发送「测试自建api」验证连通性。`
      : '✅ 已清空自建音源配置。')
  }

  async setApiMode(e) {
    if (!isLoginAuthorized(e)) return e.reply('❌ 权限不足：仅主人及登录白名单用户可修改音源模式。')
    const raw = textOf(e).replace(/^(?:自建api模式|自建音源模式|音源模式)\s*/i, '').trim().toLowerCase()
    if (!raw) return e.reply(`当前模式：${config.customApiPriority}\n用法：自建api模式 fallback（官方优先）或 first（自建优先）`)
    if (/^(?:first|优先|1)$/.test(raw)) config.customApiPriority = 'first'
    else if (/^(?:fallback|兜底|2|default)$/.test(raw)) config.customApiPriority = 'fallback'
    else return e.reply('❌ 未知模式，请使用 fallback 或 first。')
    saveConfig()
    return e.reply(`✅ 音源调度模式已切换为：${config.customApiPriority === 'first' ? '优先自建' : '官方优先、自建兜底'}`)
  }

  async testApi(e) {
    if (!isLoginAuthorized(e)) return e.reply('❌ 权限不足：仅主人及登录白名单用户可测试接口。')
    if (!config.customApiUrl) return e.reply('❌ 尚未配置自建 API，请先发送「设置自建api <URL>」。')
    const template = /\{[^}]+\}/.test(config.customApiUrl)
    const target = template
      ? config.customApiUrl.replaceAll('{song_id}', '0').replaceAll('{songmid}', '0').replaceAll('{id}', '0')
        .replaceAll('{platform}', 'netease').replaceAll('{name}', 'test').replaceAll('{artist}', 'test').replaceAll('{quality}', '320')
      : `${config.customApiUrl.replace(/\/$/, '')}/health`
    const headers = {}
    if (config.customApiToken) {
      headers.Authorization = /^bearer\s/i.test(config.customApiToken)
        ? config.customApiToken : `Bearer ${config.customApiToken}`
      headers['X-API-Key'] = config.customApiToken
      headers.Token = config.customApiToken
    }
    try {
      const response = await fetch(target, { headers, signal: AbortSignal.timeout(6000) })
      const okay = [200, 400, 404].includes(response.status)
      return e.reply(okay
        ? `🎉 自建音源服务响应正常（HTTP ${response.status}）。`
        : `❌ 自建服务返回 HTTP ${response.status}，请检查地址和服务状态。`)
    } catch (err) {
      return e.reply(`❌ 自建音源连接失败：${err.message}`)
    }
  }

  async refreshQq(e) {
    if (!isLoginAuthorized(e)) return e.reply('❌ 权限不足：仅主人及登录白名单用户可刷新凭据。')
    if (!loadQqCredential()) return e.reply('❌ 未检测到 QQ 移动端凭据，请先发送「QQ登录」扫码绑定。')
    await e.reply('正在请求 QQ 音乐官方服务器刷新凭据，请稍候…')
    const result = await refreshQqCredential()
    if (!result.ok) return e.reply(`❌ QQ 音乐凭据刷新失败：${result.message}\n若已失效，请重新扫码登录。`)
    return e.reply(`🎉 QQ 音乐凭据刷新成功！账号：${result.credential.nick || result.credential.musicid}\n新凭据已保存并延期。`)
  }

  async whitelist(e) {
    const raw = textOf(e)
    const listing = /^(?:(?:点歌)\s*)?(?:点歌白名单|点歌白名单列表|白名单|白名单列表|音乐白名单)$/.test(raw)
    if (listing) {
      if (!isLoginAuthorized(e)) return e.reply('❌ 权限不足：仅主人及白名单用户可查看授权列表。')
      const ids = Array.isArray(config.loginWhitelist) ? config.loginWhitelist : []
      return e.reply(ids.length
        ? `【MusicUID 登录白名单】\n${ids.map(id => `• ${id}`).join('\n')}\n\n主人可用「点歌加白 <ID>」授权。`
        : '【MusicUID 登录白名单】\n当前列表为空（机器人主人始终拥有凭据管理权限）。')
    }
    const add = /加白|添加白名单|白名单添加/.test(raw)
    if (!isOwner(e)) return e.reply('❌ 权限不足：只有机器人主人可以管理登录白名单。')
    const args = raw.replace(/^点歌\s*/i, '').replace(/^(?:加白|添加白名单|白名单添加|删白|删除白名单|白名单删除)\s*/i, '')
    const targets = extractUserIds(e, args)
    if (!targets.length) return e.reply(`请指定用户 ID 或 @用户，例如：\n• 点歌${add ? '加白' : '删白'} 12345678\n• @用户 点歌${add ? '加白' : '删白'}`)
    const current = Array.isArray(config.loginWhitelist) ? config.loginWhitelist.map(String) : []
    const changed = []
    for (const id of targets) {
      const index = current.indexOf(id)
      if (add && index < 0) { current.push(id); changed.push(id) }
      if (!add && index >= 0) { current.splice(index, 1); changed.push(id) }
    }
    if (!changed.length) return e.reply(add ? `这些用户已在白名单中：${targets.join(', ')}` : `这些用户不在白名单中：${targets.join(', ')}`)
    config.loginWhitelist = current
    saveConfig()
    logger.info(`[MusicUID] ${e.user_id} ${add ? '添加' : '移除'}了登录白名单：${changed.join(', ')}`)
    return e.reply(`${add ? '✅ 已加入' : '✅ 已移除'}登录白名单：${changed.join(', ')}`)
  }

  async cookie(e) {
    if (!isLoginAuthorized(e)) return e.reply('❌ 权限不足：仅主人及登录白名单用户可配置 Cookie。')
    const text = textOf(e).replace(/^点歌\s+(?=(?:设置cookie|导入cookie|cookie|绑定)(?:\s|$))/i, '点歌')
    const specific = text.match(/^(?:点歌)?(qq音乐cookie|qqcookie|qq_cookie|网易云cookie|网易cookie|酷狗cookie)\s*(.*)$/i)
    const generic = text.match(/^(?:点歌)?(?:设置cookie|导入cookie|cookie|绑定)\s*(.*)$/i)
    let platform = ''
    let value = ''
    if (specific) {
      const command = specific[1].toLowerCase()
      platform = command.startsWith('qq') ? 'qq' : command.startsWith('网易') ? 'netease' : 'kugou'
      value = specific[2].trim()
      if (!value) {
        if (platform === 'qq') return e.reply('【QQ音乐 Cookie 获取】登录 y.qq.com 后，在浏览器开发者工具 Console 执行 document.cookie，复制包含 uin 与 qm_keyst 的 Cookie；也可直接发送「QQ登录」扫码。')
        if (platform === 'netease') return e.reply('【网易云 Cookie 获取】登录 music.163.com，在开发者工具 Application → Cookies 中复制 MUSIC_U 的值，然后发送「网易云cookie <值>」。')
        return e.reply('酷狗支持扫码登录，发送「酷狗登录」；也可用「酷狗cookie <Cookie>」手动导入。')
      }
    } else if (generic) {
      const body = generic[1].trim()
      const splitAt = body.search(/\s/)
      if (splitAt < 0) return e.reply('用法：设置cookie <平台> <Cookie值>，平台支持 qq、网易云、酷狗。')
      const platformName = body.slice(0, splitAt)
      platform = platformFrom(platformName)
      value = body.slice(splitAt).trim()
      if (!platform) return e.reply(`未知平台「${platformName}」，支持：网易云、QQ、酷狗。`)
      if (!value) return e.reply('Cookie 值为空。')
    } else {
      return e.reply('Cookie 指令：网易云cookie <MUSIC_U>、QQ音乐cookie <Cookie>、酷狗cookie <Cookie>，或设置cookie <平台> <值>。')
    }

    if (platform === 'qq') {
      const formatted = formatQqCookie(value)
      const missing = ['uin=', 'qm_keyst='].filter(key => !formatted.includes(key))
      if (missing.length) return e.reply(`❌ QQ 音乐 Cookie 缺少 ${missing.join('、')}；发送「QQ音乐cookie」查看教程，或扫码登录。`)
      config.qqCookie = formatted
    } else if (platform === 'netease') {
      let cookie = value
      if (!cookie.includes('MUSIC_U=') && !cookie.includes('=')) cookie = `MUSIC_U=${cookie}`
      if (!cookie.includes('MUSIC_U=')) return e.reply('❌ 没有识别到 MUSIC_U，请发送「网易云cookie」查看教程。')
      config.neteaseCookie = cookie
    } else {
      config.kugouCookie = value
    }
    saveConfig()
    logger.info(`[MusicUID] 已更新 ${PLATFORMS[platform].name} Cookie`)
    return e.reply(`✅ 已更新【${PLATFORMS[platform].name}】Cookie：${maskSecret(value)}`)
  }

  async login(e) {
    if (!isLoginAuthorized(e)) return e.reply('❌ 权限不足：仅主人及登录白名单用户可扫码登录。')
    const raw = textOf(e)
    const lower = raw.toLowerCase()
    let platform = ''
    if (/酷狗|kugou|\bkg\b/.test(lower)) platform = 'kugou'
    else if (/qq/.test(lower)) platform = 'qq'
    else if (/网易|netease|163|wyy/.test(lower)) platform = 'netease'
    if (!platform) {
      return e.reply([
        '🎵【MusicUID 登录与配置】',
        '• QQ 音乐：QQ登录 或 点歌登录 qq（手机 QQ 扫码并自动续期）',
        '• 酷狗音乐：酷狗登录 或 点歌登录 酷狗（手机酷狗扫码）',
        '• 网易云音乐：网易云登录 或 点歌登录 网易云（手机网易云音乐扫码）',
        '• 自建音源：设置自建api <URL>；模式：自建api模式 fallback|first',
        '• 状态与授权：点歌状态、点歌加白、点歌删白、点歌白名单',
      ].join('\n'))
    }
    await e.reply(`正在生成【${PLATFORMS[platform].name}】登录二维码，请稍候…`)
    try {
      const createSession = { qq: createQqLoginSession, kugou: createKugouLoginSession, netease: createNeteaseLoginSession }[platform]
      const session = await createSession()
      const image = global.segment?.image?.(session.qrBytes)
      if (image) await e.reply([image, `\n${session.message}\n二维码约 2 分钟有效，请使用对应 APP 扫码并确认。`])
      else await e.reply(`请扫码登录：${session.qrUrl}\n${session.message}`)
      startLoginPolling(e, platform, session)
    } catch (err) {
      logger.warn(`[MusicUID] 生成 ${PLATFORMS[platform].name} 二维码失败：${err.message}`)
      await e.reply(`❌ 生成【${PLATFORMS[platform].name}】二维码失败：${err.message}`)
    }
    return true
  }

  async resolveLink(e) {
    if (!config.enableResolve) return false
    const text = textOf(e).replace(/\\\//g, '/')
    const candidates = [...text.matchAll(/https?:\/\/[^\s<>"'()]+/gi)].map(match => match[0])
    let url
    for (const candidate of candidates) {
      try {
        const parsed = new URL(candidate)
        const host = parsed.hostname.toLowerCase()
        if (host === 'music.163.com' || host.endsWith('.music.163.com') || host === '163cn.tv' || host.endsWith('.163cn.tv')
          || host === 'y.qq.com' || host.endsWith('.y.qq.com') || host === 'kugou.com' || host.endsWith('.kugou.com')) {
          url = parsed
          break
        }
      } catch { /* Ignore malformed links inside message cards. */ }
    }
    if (!url) return false
    if (url.hostname === '163cn.tv' || url.hostname.endsWith('.163cn.tv') || url.hostname === 'c6.y.qq.com') {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 8000)
        let response
        try { response = await fetch(url, { redirect: 'follow', signal: controller.signal }) } finally { clearTimeout(timer) }
        if (response.url) url = new URL(response.url)
      } catch (err) {
        logger.debug(`[MusicUID] 短链接展开失败：${err.message}`)
        return false
      }
    }
    const target = `${url.pathname}${url.search}${url.hash}`
    const host = url.hostname.toLowerCase()
    const isNetease = host === 'music.163.com' || host.endsWith('.music.163.com')
    const isQq = host === 'y.qq.com' || host.endsWith('.y.qq.com')
    const isKugou = host === 'kugou.com' || host.endsWith('.kugou.com')
    try {
      const neteaseSong = target.match(/\/song\?(?:[^#]*&)?id=(\d+)/)
      const neteaseCollection = target.match(/\/(playlist|album)\?(?:[^#]*&)?id=(\d+)/)
      const qqSong = target.match(/[?&#]songid=(\d+)/) || target.match(/[?&#]songmid=([\da-z]+)/i) || target.match(/songDetail\/([\da-z]+)/i)
      const qqPlaylist = target.match(/\/(?:n\/)?(?:ryqq|yqq)\/playlist\/(\d+)/i) || target.match(/[?&#]disstid=(\d+)/i)
      const kugouHash = target.match(/[?&#]hash=([\da-f]{32})/i)
      const kugouAlbumId = target.match(/[?&#]album_id=(\d+)/i)?.[1] || ''
      const kugouAlbumAudioId = target.match(/[?&#]album_audio_id=(\d+)/i)?.[1] || ''
      const kugouChain = target.match(/[?&#]chain=([\da-z]+)/i)
      const kugouPlaylist = target.match(/\/(?:yy\/)?special\/single\/(\d+)(?:\.html)?/i)
        || target.match(/\/plist\/(?:list\/)?(\d+)/i)
        || target.match(/[?&#](?:specialid|global_collection_id)=(\d+)/i)
      let song = null
      if (isNetease && neteaseSong) song = await neteaseDetail(neteaseSong[1])
      else if (isQq && qqSong) song = await qqDetail(qqSong[1])
      else if (isKugou && kugouHash) song = await kugouDetail(kugouHash[1], kugouAlbumId, kugouAlbumAudioId)
      else if (isKugou && kugouChain) {
        const sharePage = queryUrl('https://m.kugou.com/share/song.html', { chain: kugouChain[1] })
        const html = await requestText(sharePage)
        const hash = html.match(/"hash"\s*:\s*"([\da-f]{32})"/i)?.[1]
        if (hash) song = await kugouDetail(hash)
      }
      if (song) {
        await deliver(e, song)
        return true
      }
      if (isQq && qqPlaylist) {
        const collection = await qqPlaylistDetail(qqPlaylist[1])
        if (!collection.songs.length) return e.reply('没有解析到 QQ 音乐歌单曲目。')
        await sendSongList(e, collection.name, [{ platform: 'qq', songs: collection.songs }])
        return true
      }
      if (isKugou && kugouPlaylist) {
        const collection = await kugouPlaylistDetail(kugouPlaylist[1])
        if (!collection.songs.length) return e.reply('没有解析到酷狗歌单曲目。')
        await sendSongList(e, collection.name, [{ platform: 'kugou', songs: collection.songs }])
        return true
      }
      if (isNetease && neteaseCollection) {
        const [, kind, id] = neteaseCollection
        const endpoint = kind === 'playlist'
          ? queryUrl('https://music.163.com/api/v6/playlist/detail', { id, n: 30, s: 0 })
          : `https://music.163.com/api/album/${encodeURIComponent(id)}`
        const data = await requestJson(endpoint, { headers: { Referer: 'https://music.163.com/' } })
        const node = kind === 'playlist' ? data?.playlist : data?.album
        const rawSongs = kind === 'playlist' ? node?.tracks : node?.songs
        const songs = (rawSongs || []).map(item => makeSong('netease', item.id, item.name, artistsOf(item.ar || item.artists), {
          album: item.al?.name || item.album?.name,
          duration: (item.dt || item.duration || 0) / 1000,
          payplay: [1, 4].includes(Number(item.fee)),
        })).filter(Boolean).slice(0, Number(config.maxList) || 5)
        if (!songs.length) return e.reply('没有解析到歌单/专辑曲目。')
        saveSession(e, songs, node.name || '网易云歌单')
        await sendSongList(e, node.name || '网易云歌单', [{ platform: 'netease', songs }])
        return true
      }
    } catch (err) {
      logger.warn(`[MusicUID] 分享链接解析失败：${err.message}`)
      await e.reply(`分享链接解析失败：${err.message}`)
      return true
    }
    return false
  }
}
