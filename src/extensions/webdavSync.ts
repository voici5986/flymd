// 内置扩展：WebDAV 同步（极简策略）
// - F5 手动同步；启动时同步；关闭前异步触发同步（不阻塞）
// - 仅按最后修改时间比较；新者覆盖旧者；不做合并

import { Store } from '@tauri-apps/plugin-store'
import { getActiveLibraryRoot, getActiveLibraryId } from '../utils/library'
import { readDir, stat, readFile, writeFile, mkdir, exists, open as openFileHandle, BaseDirectory, remove } from '@tauri-apps/plugin-fs'
import { appLocalDataDir } from '@tauri-apps/api/path'
import { openPath } from '@tauri-apps/plugin-opener'
import { ask } from '@tauri-apps/plugin-dialog'
import { t } from '../i18n'
import { showConflictDialog, showLocalDeleteDialog, showRemoteDeleteDialog, showUploadMissingRemoteDialog } from '../dialog'

// 当前同步通知ID（用于更新同一条通知）
let _currentSyncNotificationId: string | null = null

// 更新同步状态显示（使用新的通知系统）
function updateStatus(msg: string) {
  try {
    const NotificationManager = (window as any).NotificationManager
    if (!NotificationManager) {
      // 降级：使用旧方式
      const el = document.getElementById('sync-status') || document.getElementById('notification-container')
      if (el) el.textContent = msg
      return
    }

    // 如果已有同步通知，更新它；否则创建新的
    if (_currentSyncNotificationId) {
      NotificationManager.updateMessage(_currentSyncNotificationId, msg)
    } else {
      // 创建持久化通知（duration=0表示不自动清除）
      _currentSyncNotificationId = NotificationManager.show('sync', msg, 0)
    }
  } catch (e) {
    console.warn('[Sync] 更新状态失败', e)
  }
}

// 清空同步状态
function clearStatus(delayMs: number = 5000) {
  try {
    const NotificationManager = (window as any).NotificationManager
    if (!NotificationManager) {
      // 降级：使用旧方式
      const el = document.getElementById('sync-status') || document.getElementById('notification-container')
      if (el) {
        setTimeout(() => {
          try { if (el) el.textContent = '' } catch {}
        }, delayMs)
      }
      return
    }

    // 延迟清除当前同步通知
    if (_currentSyncNotificationId) {
      const id = _currentSyncNotificationId
      setTimeout(() => {
        try {
          NotificationManager.hide(id)
        } catch {}
      }, delayMs)
      _currentSyncNotificationId = null
    }
  } catch (e) {
    console.warn('[Sync] 清除状态失败', e)
  }
}

// 计算文件内容的 MD5 哈希
async function calculateFileHash(data: Uint8Array): Promise<string> {
  try {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data as any)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    return hashHex
  } catch (e) {
    console.warn('计算哈希失败', e)
    return ''
  }
}

// 同步元数据类型
type SyncMetadata = {
  files: {
    [path: string]: {
      hash: string
      mtime: number
      size: number  // 添加文件大小字段
      syncTime: number
      remoteMtime?: number  // 远端修改时间
      remoteEtag?: string   // 远端ETag
    }
  }
  lastSyncTime: number
  // 新增：远端目录属性快照（用于远端扫描剪枝）
  // 仅记录目录条目的 mtime/etag（若服务器提供）
  dirs?: {
    [dir: string]: { mtime?: number; etag?: string }
  }
}

const LEGACY_META_FILENAME = 'flymd-sync-meta.json'
const PROFILE_META_PREFIX = 'flymd-sync-meta-'

type SyncProfileInput = { localRoot: string; baseUrl: string; remoteRoot: string }
type SyncProfileContext = { key: string; metaPath: string; legacyPath: string }
type SyncMetadataState = { meta: SyncMetadata; profile: SyncProfileContext; isFreshProfile: boolean; legacyDetected: boolean }

function joinLocalDataPath(dir: string, file: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  const cleanDir = dir.replace(/[\\/]+$/, '')
  return cleanDir + sep + file
}

function normalizeLocalRootForKey(root: string): string {
  if (!root) return ''
  return root.replace(/\\/g, '/').replace(/\/+$/, '')
}

function normalizeRemoteRootForKey(path: string): string {
  if (!path) return '/'
  let p = path.replace(/\\/g, '/').trim()
  if (!p.startsWith('/')) p = '/' + p
  p = p.replace(/\/+$/, '')
  return p || '/'
}

function normalizeBaseUrlForKey(url: string): string {
  const trimmed = (url || '').trim()
  if (!trimmed) return ''
  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed
    const u = new URL(normalized)
    const protocol = (u.protocol || '').toLowerCase()
    const host = (u.host || '').toLowerCase()
    let pathname = (u.pathname || '').replace(/\\/g, '/')
    pathname = pathname.replace(/\/+$/, '')
    return `${protocol}//${host}${pathname}`
  } catch {
    return trimmed.replace(/\\/g, '/').replace(/\/+$/, '')
  }
}

async function hashProfileKey(input: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(input)
    const buf = await crypto.subtle.digest('SHA-1', data as any)
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    let hash = 0
    for (let i = 0; i < input.length; i++) {
      hash = (hash * 31 + input.charCodeAt(i)) >>> 0
    }
    return hash.toString(16)
  }
}

async function resolveSyncProfile(input: SyncProfileInput): Promise<SyncProfileContext> {
  const { localRoot, baseUrl, remoteRoot } = input
  const keyRaw = `${normalizeLocalRootForKey(localRoot)}|${normalizeBaseUrlForKey(baseUrl)}|${normalizeRemoteRootForKey(remoteRoot)}`
  const key = await hashProfileKey(keyRaw)
  const localDataDir = await appLocalDataDir()
  const metaPath = joinLocalDataPath(localDataDir, `${PROFILE_META_PREFIX}${key}.json`)
  const legacyPath = joinLocalDataPath(localDataDir, LEGACY_META_FILENAME)
  return { key, metaPath, legacyPath }
}

async function readMetadataFile(metaPath: string): Promise<SyncMetadata | null> {
  let rawData: Uint8Array | null = null
  try {
    rawData = await readFile(metaPath as any)
    const text = new TextDecoder().decode(rawData)
    if (!text || text.trim().length === 0) {
      return { files: {}, lastSyncTime: 0 }
    }
    const rawMeta = JSON.parse(text) as any

    const files: SyncMetadata['files'] = {}
    for (const [path, meta] of Object.entries(rawMeta.files || {})) {
      const m = meta as any
      files[path] = {
        hash: m.hash || '',
        mtime: m.mtime || 0,
        size: m.size || 0,
        syncTime: m.syncTime || 0,
        remoteMtime: m.remoteMtime || undefined,
        remoteEtag: m.remoteEtag || undefined
      }
    }

    const dirs: SyncMetadata['dirs'] = {}
    try {
      const rawDirs = rawMeta.dirs || {}
      if (rawDirs && typeof rawDirs === 'object') {
        for (const [k, v] of Object.entries(rawDirs)) {
          const dv = v as any
          dirs[k] = { mtime: Number(dv?.mtime) || undefined, etag: dv?.etag ? String(dv.etag) : undefined }
        }
      }
    } catch {}

    return { files, lastSyncTime: rawMeta.lastSyncTime || 0, dirs }
  } catch (e) {
    console.warn('读取同步元数据失败', e)
    if (e instanceof SyntaxError && rawData) {
      console.warn('元数据文件损坏，将使用空元数据重新开始同步')
      const backupPath = metaPath + '.corrupted.' + Date.now()
      try {
        await writeFile(backupPath as any, rawData as any)
        console.log('已备份损坏的元数据文件到: ' + backupPath)
      } catch {}
    }
    return null
  }
}

async function loadSyncMetadataProfile(input: SyncProfileInput): Promise<SyncMetadataState> {
  const profile = await resolveSyncProfile(input)
  let profileExists = false
  try {
    profileExists = await exists(profile.metaPath as any)
  } catch {
    profileExists = false
  }

  let loaded: SyncMetadata | null = null
  if (profileExists) {
    loaded = await readMetadataFile(profile.metaPath)
  }

  const isFreshProfile = !loaded
  let legacyDetected = false
  let meta: SyncMetadata | null = loaded
  if (isFreshProfile) {
    try {
      legacyDetected = await exists(profile.legacyPath as any)
    } catch {
      legacyDetected = false
    }

    // 尝试从旧版全局元数据中恢复可用信息（仅作为提示，不直接驱动删除逻辑）
    if (!meta && legacyDetected) {
      try {
        const legacyMeta = await readMetadataFile(profile.legacyPath)
        if (legacyMeta) {
          meta = legacyMeta
        }
      } catch {
        // 读取失败时忽略，保持空元数据，防止误用损坏的旧数据
        meta = null
      }
    }
  }

  return { meta: meta || { files: {}, lastSyncTime: 0 }, profile, isFreshProfile, legacyDetected }
}

// 保存同步元数据
async function saveSyncMetadata(meta: SyncMetadata, profile: SyncProfileContext): Promise<void> {
  try {
    const text = JSON.stringify(meta, null, 2)
    const data = new TextEncoder().encode(text)
    await writeFile(profile.metaPath as any, data as any)
    try {
      await writeFile(profile.legacyPath as any, data as any)
    } catch {}
  } catch (e) {
    console.warn('保存同步元数据失败', e)
  }
}

async function syncLog(msg: string): Promise<void> {
  try {
    const ts = new Date()
    const localTs = (() => {
      try { return ts.toLocaleString(undefined, { hour12: false }) } catch { return ts.toString() }
    })()
    const enc = new TextEncoder().encode(localTs + ' ' + msg + '\n')
    const logPath = 'flymd-sync.log'
    const logHandle = await openFileHandle(logPath as any, { read: true, write: true, append: true, create: true, baseDir: BaseDirectory.AppLocalData } as any)
    try {
      const STAT_THRESHOLD = 5 * 1024 * 1024 // 5MB
      try {
        const statInfo = await stat(logPath as any)
        if (statInfo && typeof statInfo.size === 'number' && statInfo.size > STAT_THRESHOLD) {
          // 先关闭句柄再截断（Windows 下需要重新打开为写模式）
          try { await (logHandle as any).close() } catch {}
          const fresh = await openFileHandle(logPath as any, { write: true, truncate: true, create: true, baseDir: BaseDirectory.AppLocalData } as any)
          try { await (fresh as any).write(enc as any) } finally { try { await (fresh as any).close() } catch {} }
          return
        }
      } catch {}
      await (logHandle as any).write(enc as any)
    } finally {
      try { await (logHandle as any).close() } catch {}
    }
  } catch {}
}

// HTTP 请求重试：最多 3 次，指数退避 + 抖动
const MAX_HTTP_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withHttpRetry<T>(label: string, fn: (attempt: number) => Promise<T>): Promise<T> {
  let lastErr: any = null
  for (let attempt = 1; attempt <= MAX_HTTP_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        try { await syncLog(`[retry] ${label} attempt=${attempt}`) } catch {}
      }
      const result = await fn(attempt)
      if (attempt > 1) {
        try { await syncLog(`[retry-ok] ${label} succeed attempt=${attempt}`) } catch {}
      }
      return result
    } catch (e) {
      lastErr = e
      if (attempt >= MAX_HTTP_RETRIES) break
      const base = 500
      const backoff = base * (2 ** (attempt - 1))
      const jitter = Math.random() * backoff * 0.5
      const delay = backoff + jitter
      try {
        await syncLog(`[retry-wait] ${label} failed attempt=${attempt}, nextDelay≈${Math.round(delay)}ms: ` + ((e as any)?.message || e))
      } catch {}
      await sleep(delay)
    }
  }
  throw lastErr
}
export async function openSyncLog(): Promise<void> {
  try {
    const localDataDir = await appLocalDataDir()
    const logPath = localDataDir + (localDataDir.includes('\\') ? '\\' : '/') + 'flymd-sync.log'
    await openPath(logPath)
  } catch (e) {
    console.warn('打开日志失败', e)
    alert('打开日志失败: ' + ((e as any)?.message || e))
  }
}

import { getCurrentWindow } from '@tauri-apps/api/window'

// 本地结构快照（存放于库根目录），用于快速短路“无变化”的同步
// 注意：仅作为性能优化的提示，真实一致性仍由常规流程保障
const LOCAL_HINT_FILENAME = '.flymd-sync-hint.json'

type LocalStructureHint = {
  totalDirs: number
  totalFiles: number
  maxMtime: number
}

// 从库根读取快照
async function readLocalStructureHint(root: string): Promise<LocalStructureHint | null> {
  try {
    const sep = root.includes('\\') ? '\\' : '/'
    const hintPath = root.replace(/[\\/]+$/, '') + sep + LOCAL_HINT_FILENAME
    if (!(await exists(hintPath as any))) return null
    const data = await readFile(hintPath as any)
    const text = new TextDecoder().decode(data)
    if (!text.trim()) return null
    const obj = JSON.parse(text)
    if (typeof obj.totalFiles === 'number' && typeof obj.totalDirs === 'number' && typeof obj.maxMtime === 'number') {
      return obj as LocalStructureHint
    }
    return null
  } catch { return null }
}

// 写入快照到库根
async function writeLocalStructureHint(root: string, hint: LocalStructureHint): Promise<void> {
  try {
    const sep = root.includes('\\') ? '\\' : '/'
    const hintPath = root.replace(/[\\/]+$/, '') + sep + LOCAL_HINT_FILENAME
    const text = JSON.stringify(hint)
    const data = new TextEncoder().encode(text)
    await writeFile(hintPath as any, data as any)
  } catch {}
}

// 轻量汇总：仅统计目录数、文件数与最大修改时间；跳过隐藏项与非同步扩展
async function quickSummarizeLocal(root: string): Promise<LocalStructureHint> {
  let totalFiles = 0
  let totalDirs = 0
  let maxMtime = 0

  async function walk(dir: string) {
    let ents: any[] = []
    try { ents = await readDir(dir, { recursive: false } as any) as any[] } catch { ents = [] }
    for (const e of ents) {
      const name = String(e.name || '')
      if (!name) continue
      if (name.startsWith('.')) continue
      const full = dir + (dir.includes('\\') ? '\\' : '/') + name
      try {
        let isDir = !!(e as any)?.isDirectory
        if ((e as any)?.isDirectory === undefined) {
          try { const st = await stat(full) as any; isDir = !!st?.isDirectory } catch { isDir = false }
        }
        if (isDir) {
          totalDirs++
          await walk(full)
        } else {
          if (!/\.(md|markdown|txt|png|jpg|jpeg|gif|svg|pdf)$/i.test(name)) continue
          totalFiles++
          try {
            const meta = await stat(full)
            const mt = Number((meta as any)?.modifiedAt || (meta as any)?.mtime || (meta as any)?.mtimeMs || 0)
            if (mt > maxMtime) maxMtime = mt
          } catch {}
        }
      } catch {}
    }
  }

  await walk(root)
  return { totalDirs, totalFiles, maxMtime }
}

export type SyncReason = 'manual' | 'startup' | 'shutdown'

export type WebdavSyncConfig = {
  enabled: boolean
  onStartup: boolean
  onShutdown: boolean
  timeoutMs: number
  includeGlobs: string[]
  excludeGlobs: string[]
  baseUrl: string
  username: string
  password: string
  rootPath: string
  clockSkewMs?: number
  conflictStrategy?: 'ask' | 'newest' | 'last-wins'  // 冲突策略
  skipRemoteScanMinutes?: number  // 跳过远程扫描的时间间隔（分钟）
  confirmDeleteRemote?: boolean  // 删除远程文件时是否需要确认（默认true）
  localDeleteStrategy?: 'ask' | 'auto' | 'keep'  // 本地文件删除策略：询问用户/自动删除/保留本地（默认auto）
  allowHttpInsecure?: boolean  // 是否允许 HTTP 明文 WebDAV
  allowedHttpHosts?: string[]  // 允许的 HTTP 主机白名单
  // WebDAV 内容加密配置（仅影响上传到 WebDAV 的内容）
  encryptEnabled?: boolean
  encryptKey?: string
  encryptSalt?: string
}

let _store: Store | null = null
async function getStore(): Promise<Store> {
  if (_store) return _store
  _store = await Store.load('flymd-settings.json')
  return _store
}

// Base64 编解码工具（用于存储盐值）
function bytesToBase64(bytes: Uint8Array): string {
  try {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  } catch {
    // 回退为十六进制字符串（不推荐，仅作为兜底）
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }
}

function base64ToBytes(b64: string): Uint8Array {
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    const clean = b64.replace(/[^0-9a-f]/gi, '')
    const len = Math.floor(clean.length / 2)
    const out = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      const byte = parseInt(clean.substr(i * 2, 2), 16)
      out[i] = Number.isFinite(byte) ? byte : 0
    }
    return out
  }
}

function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length)
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(buf)
      return buf
    }
  } catch {}
  for (let i = 0; i < length; i++) buf[i] = Math.floor(Math.random() * 256)
  return buf
}

function sanitizeHttpHosts(list: any): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const v = typeof item === 'string' ? item.trim() : ''
    if (v) out.push(v)
  }
  return out
}

// 旧版同步配置是否为“全局配置”形态（未按库拆分）
function isLegacySyncConfigShape(raw: any): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  if (raw.profiles && typeof raw.profiles === 'object') return false
  return (
    'baseUrl' in raw ||
    'rootPath' in raw ||
    'enabled' in raw ||
    'onStartup' in raw ||
    'onShutdown' in raw
  )
}

// 从存储的原始对象构造完整配置（带默认值），保持向后兼容
function buildWebdavConfigFromRaw(raw: any): WebdavSyncConfig {
  const cfg: WebdavSyncConfig = {
    enabled: raw?.enabled === true,
    onStartup: raw?.onStartup === true,
    onShutdown: raw?.onShutdown === true,
    timeoutMs: Number(raw?.timeoutMs) > 0 ? Number(raw?.timeoutMs) : 120000,
    includeGlobs: Array.isArray(raw?.includeGlobs) ? raw.includeGlobs : ['**/*.md', '**/*.{png,jpg,jpeg,gif,svg,pdf}'],
    excludeGlobs: Array.isArray(raw?.excludeGlobs) ? raw.excludeGlobs : ['**/.git/**','**/.trash/**','**/.DS_Store','**/Thumbs.db'],
    baseUrl: String(raw?.baseUrl || ''),
    username: String(raw?.username || ''),
    password: String(raw?.password || ''),
    rootPath: String(raw?.rootPath || '/flymd'),
    clockSkewMs: Number(raw?.clockSkewMs) || 0,
    conflictStrategy: raw?.conflictStrategy || 'newest',
    skipRemoteScanMinutes: Number(raw?.skipRemoteScanMinutes) >= 0 ? Number(raw?.skipRemoteScanMinutes) : 5,
    confirmDeleteRemote: raw?.confirmDeleteRemote !== false,
    localDeleteStrategy: raw?.localDeleteStrategy || 'auto',
    allowHttpInsecure: raw?.allowHttpInsecure === true,
    allowedHttpHosts: sanitizeHttpHosts(raw?.allowedHttpHosts),
    encryptEnabled: raw?.encryptEnabled === true,
    encryptKey: typeof raw?.encryptKey === 'string' ? raw.encryptKey : '',
    encryptSalt: typeof raw?.encryptSalt === 'string' ? raw.encryptSalt : '',
  }
  return cfg
}

// 读取当前库对应的 WebDAV 配置（按库隔离，兼容旧版全局配置）
export async function getWebdavSyncConfig(): Promise<WebdavSyncConfig> {
  const store = await getStore()
  const raw = (await store.get('sync')) as any
  let storeValue: any = raw

  const libId = await (async () => {
    try { return await getActiveLibraryId() } catch { return null }
  })()

  // 统一存储结构：{ version, profiles: { [libId]: rawCfg } }
  if (!storeValue || typeof storeValue !== 'object' || Array.isArray(storeValue)) {
    storeValue = { version: 1, profiles: {} as Record<string, any> }
  }

  let migrated = false

  if (!storeValue.profiles || typeof storeValue.profiles !== 'object' || Array.isArray(storeValue.profiles)) {
    // 旧版：直接将全局配置迁移到“当前库”的 profile 下
    const profiles: Record<string, any> = {}
    if (libId && isLegacySyncConfigShape(storeValue)) {
      profiles[libId] = { ...storeValue }
    }
    storeValue = { version: 1, profiles }
    migrated = true
  }

  const profiles = storeValue.profiles as Record<string, any>

  // 如果仍然是旧版形态（没有 profiles，但字段像配置），再兜底迁移一次
  if (libId && isLegacySyncConfigShape(raw) && !profiles[libId]) {
    profiles[libId] = { ...raw }
    migrated = true
  }

  if (migrated) {
    try {
      await store.set('sync', storeValue)
      await store.save()
    } catch {}
  }

  const rawCfg = libId ? profiles[libId] || {} : {}
  return buildWebdavConfigFromRaw(rawCfg)
}

// 判断当前库是否已经显式配置过 WebDAV（用于 UI 提示）
export async function isWebdavConfiguredForActiveLibrary(): Promise<boolean> {
  const store = await getStore()
  const raw = (await store.get('sync')) as any

  const libId = await (async () => {
    try { return await getActiveLibraryId() } catch { return null }
  })()
  if (!libId) return false

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false
  }

  if (raw.profiles && typeof raw.profiles === 'object' && !Array.isArray(raw.profiles)) {
    const profiles = raw.profiles as Record<string, any>
    const cfg = profiles[libId]
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false
    const base = typeof cfg.baseUrl === 'string' ? cfg.baseUrl.trim() : ''
    const user = typeof cfg.username === 'string' ? cfg.username.trim() : ''
    const pass = typeof cfg.password === 'string' ? cfg.password.trim() : ''
    const enabled = cfg.enabled === true
    const root = typeof cfg.rootPath === 'string' ? cfg.rootPath.trim() : ''
    return !!(base || user || pass || enabled || (root && root !== '/flymd'))
  }

  // 旧形态：整份 sync 就是一份配置，视为“已配置”
  if (isLegacySyncConfigShape(raw)) {
    const base = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
    const user = typeof raw.username === 'string' ? raw.username.trim() : ''
    const pass = typeof raw.password === 'string' ? raw.password.trim() : ''
    const enabled = raw.enabled === true
    const root = typeof raw.rootPath === 'string' ? raw.rootPath.trim() : ''
    return !!(base || user || pass || enabled || (root && root !== '/flymd'))
  }

  return false
}

// 为当前激活库写入 WebDAV 配置（每个库有独立 profile）
export async function setWebdavSyncConfig(next: Partial<WebdavSyncConfig>): Promise<void> {
  const store = await getStore()
  const raw = (await store.get('sync')) as any
  let storeValue: any = raw

  const libId = await (async () => {
    try { return await getActiveLibraryId() } catch { return null }
  })()

  if (!storeValue || typeof storeValue !== 'object' || Array.isArray(storeValue)) {
    storeValue = { version: 1, profiles: {} as Record<string, any> }
  }

  if (!storeValue.profiles || typeof storeValue.profiles !== 'object' || Array.isArray(storeValue.profiles)) {
    const profiles: Record<string, any> = {}
    if (libId && isLegacySyncConfigShape(storeValue)) {
      profiles[libId] = { ...storeValue }
    }
    storeValue = { version: 1, profiles }
  }

  const profiles = storeValue.profiles as Record<string, any>
  const curRaw = (libId && profiles[libId] && typeof profiles[libId] === 'object' && !Array.isArray(profiles[libId]))
    ? profiles[libId]
    : {}
  const merged: any = { ...curRaw, ...next }

  // 若开启加密且已有密钥但尚无盐值，则生成一个固定盐值（每个配置唯一）
  try {
    const enabled = merged.encryptEnabled === true
    const key = typeof merged.encryptKey === 'string' ? merged.encryptKey.trim() : ''
    const hasSalt = typeof merged.encryptSalt === 'string' && !!merged.encryptSalt
    if (enabled && key && !hasSalt) {
      const salt = randomBytes(16)
      merged.encryptSalt = bytesToBase64(salt)
    }
  } catch {}

  if (Array.isArray(merged.allowedHttpHosts)) {
    merged.allowedHttpHosts = merged.allowedHttpHosts.map((v: any) => typeof v === 'string' ? v.trim() : '').filter((v: string) => !!v)
  }
  if (libId) {
    profiles[libId] = merged
    storeValue.version = 1
    storeValue.profiles = profiles
  } else {
    // 理论上不会走到这里（必须有激活库），兜底保持旧行为
    storeValue = merged
  }

  await store.set('sync', storeValue)
  await store.save()
}

// 统一通过 utils 获取当前库根目录（兼容 legacy）

// 轻量 HTTP 客户端（优先使用 tauri plugin-http，回退到 fetch）
async function getHttpClient(): Promise<{ fetch: any; ResponseType?: any; Body?: any } | null> {
  try { const mod: any = await import('@tauri-apps/plugin-http'); if (typeof mod?.fetch === 'function') return { fetch: mod.fetch, ResponseType: mod.ResponseType, Body: mod.Body } } catch {}
  try { return { fetch: (input: string, init: any) => fetch(input, init) } as any } catch { return null }
}

function joinUrl(...parts: string[]): string {
  const segs: string[] = []
  for (const p of parts) {
    if (!p) continue
    let s = p.replace(/\\/g, '/').trim()
    if (s === '/') { segs.push(''); continue }
    s = s.replace(/^\/+/, '').replace(/\/+$/, '')
    if (s) segs.push(s)
  }
  let u = segs.join('/')
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u // 容错：用户误填
  return u
}

function encodePath(path: string): string {
  // 对每段进行 encodeURI，保留斜杠
  return path.split('/').map(encodeURIComponent).join('/')
}

function toEpochMs(v: any): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') { const t = Date.parse(v); if (Number.isFinite(t)) return t }
  try { if (v instanceof Date) return v.getTime() } catch {}
  const n = Number(v); return Number.isFinite(n) ? n : 0
}

type HostPort = { host: string; port: string }

function parseHostPort(input: string): HostPort | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const tryParse = (value: string) => {
    try { return new URL(value) } catch { return null }
  }
  let urlObj = tryParse(trimmed)
  if (!urlObj && !/^https?:\/\//i.test(trimmed)) {
    urlObj = tryParse('http://' + trimmed)
  }
  if (!urlObj) return null
  const host = urlObj.hostname?.toLowerCase() || ''
  if (!host) return null
  const port = urlObj.port || ''
  return { host, port }
}

function normalizeHttpWhitelist(list?: string[]): HostPort[] {
  if (!Array.isArray(list)) return []
  const out: HostPort[] = []
  for (const raw of list) {
    const parsed = typeof raw === 'string' ? parseHostPort(raw) : null
    if (parsed) out.push(parsed)
  }
  return out
}

function isHostAllowedByWhitelist(target: HostPort | null, whitelist: HostPort[]): boolean {
  if (!target) return false
  if (whitelist.length === 0) return true
  return whitelist.some(entry => {
    if (entry.host !== target.host) return false
    if (!entry.port) return true
    return entry.port === (target.port || '')
  })
}

type FileEntry = { path: string; mtime: number; size: number; hash?: string; isDir?: boolean; etag?: string }

async function scanLocal(root: string, lastMeta?: SyncMetadata): Promise<Map<string, FileEntry>> {
  const map = new Map<string, FileEntry>()
  let fileCount = 0

  async function walk(dir: string, rel: string) {
    let ents: any[] = []
    try { ents = await readDir(dir, { recursive: false } as any) as any[] } catch { ents = [] }
    for (const e of ents) {
      const name = String(e.name || '')
if (name.startsWith('.')) { await syncLog('[scan-skip-hidden] ' + (rel ? rel + '/' : '') + name); continue }
      if (!name) continue
      const full = dir + (dir.includes('\\') ? '\\' : '/') + name
      const relp = rel ? rel + '/' + name : name
      try {
        // 正确判断是否为目录
        let isDir = !!(e as any)?.isDirectory
        if ((e as any)?.isDirectory === undefined) {
          try { const st = await stat(full) as any; isDir = !!st?.isDirectory } catch { isDir = false }
        }

        if (isDir) {
          await walk(full, relp)
        } else {
          const meta = await stat(full)
          const mt = toEpochMs((meta as any)?.modifiedAt || (meta as any)?.mtime || (meta as any)?.mtimeMs)
          const size = Number((meta as any)?.size || 0)
          const __relUnix = relp.replace(/\\\\/g, '/')
          if (!/\.(md|markdown|txt|png|jpg|jpeg|gif|svg|pdf)$/i.test(__relUnix)) continue

          fileCount++
          if (fileCount % 10 === 0) {
            updateStatus(`扫描本地… ${fileCount} 个文件`)
          }

          // 优化：检查是否可以复用上次的哈希
          const lastFile = lastMeta?.files[__relUnix]
          let hash = ''
          if (lastFile && lastFile.size === size && lastFile.hash) {
            // 文件 size 没变且有哈希记录，复用上次的哈希（不重新计算）
            hash = lastFile.hash
            // await syncLog(`[hash-reuse] ${__relUnix}`)  // 减少日志输出
          } else {
            // 文件有变化或第一次扫描，需要计算哈希
            const fileData = await readFile(full as any)
            hash = await calculateFileHash(fileData as Uint8Array)
          }

          map.set(__relUnix, { path: __relUnix, mtime: mt, size, hash })
        }
      } catch {}
    }
  }
  await walk(root, '')
  updateStatus(`本地扫描完成，共 ${fileCount} 个文件`)
  return map
}

// PROPFIND 缓存
const _propfindCache = new Map<string, { result: any; timestamp: number }>()
const CACHE_TTL = 30000  // 30秒缓存

async function listRemoteDir(baseUrl: string, auth: { username: string; password: string }, remotePath: string): Promise<{ files: { name: string; isDir: boolean; mtime?: number; etag?: string }[] }> {
  // 检查缓存
  const cacheKey = `${baseUrl}:${remotePath}`
  const cached = _propfindCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    await syncLog(`[propfind-cache-hit] ${remotePath}`)
    return cached.result
  }

  const http = await getHttpClient(); if (!http) throw new Error('no http client')
  const url = joinUrl(baseUrl, remotePath)
  const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getetag/><d:resourcetype/></d:prop></d:propfind>`
  const headers: Record<string,string> = { Depth: '1', 'Content-Type': 'application/xml' }
  const authStr = btoa(`${auth.username}:${auth.password}`)
  headers['Authorization'] = `Basic ${authStr}`
  let text = ''

  await withHttpRetry('[propfind] ' + remotePath, async () => {
    try {
      const resp = await http.fetch(url, { method: 'PROPFIND', headers, body })
      if (resp?.ok === true || (typeof resp.status === 'number' && resp.status >= 200 && resp.status < 300)) {
        text = typeof resp.text === 'function' ? await resp.text() : (resp.data || '')
      } else {
        throw new Error('HTTP ' + (resp?.status || ''))
      }
    } catch (e) {
      // 回退：部分服务可能需要 application/xml + charset
      const resp = await http.fetch(url, { method: 'PROPFIND', headers: { ...headers, 'Content-Type': 'text/xml; charset=utf-8' }, body })
      if (resp?.ok === true || (typeof resp.status === 'number' && resp.status >= 200 && resp.status < 300)) {
        text = typeof resp.text === 'function' ? await resp.text() : (resp.data || '')
      } else { throw e }
    }
    return true as any
  })
  const files: { name: string; isDir: boolean; mtime?: number; etag?: string }[] = []
  try {
    const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml')
    const respNodes = Array.from(doc.getElementsByTagNameNS('*','response'))
    for (const r of respNodes) {
      const hrefEl = (r as any).getElementsByTagNameNS?.('*','href')?.[0] as Element | undefined
      const mEl = (r as any).getElementsByTagNameNS?.('*','getlastmodified')?.[0] as Element | undefined
      const etagEl = (r as any).getElementsByTagNameNS?.('*','getetag')?.[0] as Element | undefined
      const typeEl = (r as any).getElementsByTagNameNS?.('*','resourcetype')?.[0] as Element | undefined
      const rawHref = hrefEl?.textContent || ''
      if (!rawHref) continue

      let href = rawHref
      try { href = decodeURIComponent(rawHref) } catch {}

      // 跳过自身目录项 - 改进：比较路径部分
      const normalizeUrl = (u: string) => u.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()

      // 获取当前请求URL的路径部分
      let requestPath = ''
      try {
        const requestUrl = new URL(joinUrl(baseUrl, remotePath))
        requestPath = normalizeUrl(decodeURIComponent(requestUrl.pathname))
      } catch {
        requestPath = normalizeUrl(remotePath)
      }

      // 获取 item 的路径部分
      let itemPath = ''
      if (href.startsWith('http')) {
        try {
          itemPath = normalizeUrl(new URL(href).pathname)
        } catch {
          itemPath = normalizeUrl(href)
        }
      } else {
        itemPath = normalizeUrl(href)
      }

      if (itemPath === requestPath) continue

      // 取最后一段作为 name
      const segs = href.replace(/\/+$/,'').split('/')
      const name = segs.pop() || ''
      if (!name) continue

      // 改进目录判断
      const typeXml = typeEl?.outerHTML || typeEl?.innerHTML || ''
      const isDir = /<d:collection\b/i.test(typeXml) ||
                    /<collection\b/i.test(typeXml) ||
                    /\bcollection\b/i.test(typeXml) ||
                    rawHref.endsWith('/')
      const mt = mEl?.textContent ? toEpochMs(mEl.textContent) : undefined
      const etag = etagEl?.textContent ? String(etagEl.textContent).replace(/^["']|["']$/g, '') : undefined
      files.push({ name, isDir, mtime: mt, etag })
    }
  } catch (e) {
    await syncLog('[remote-propfind] 解析XML失败: ' + ((e as any)?.message || e))
  }

  const result = { files }
  // 保存到缓存
  _propfindCache.set(cacheKey, { result, timestamp: Date.now() })
  return result
}

// 尝试使用 Depth: infinity 一次性获取整个目录树
async function tryListRemoteInfinity(baseUrl: string, auth: { username: string; password: string }, rootPath: string): Promise<{ files: Map<string, FileEntry>; dirsProps: { [dir: string]: { mtime?: number; etag?: string } } } | null> {
  try {
    const http = await getHttpClient(); if (!http) return null
    const url = joinUrl(baseUrl, rootPath)
    const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getetag/><d:resourcetype/></d:prop></d:propfind>`
    const headers: Record<string,string> = { Depth: 'infinity', 'Content-Type': 'application/xml' }
    const authStr = btoa(`${auth.username}:${auth.password}`)
    headers['Authorization'] = `Basic ${authStr}`

    let text = ''
    const ok = await withHttpRetry('[propfind-infinity] ' + rootPath, async () => {
      const resp = await http.fetch(url, { method: 'PROPFIND', headers, body })
      const status = Number((resp as any)?.status || 0)
      const isOk = resp?.ok === true || (typeof status === 'number' && status >= 200 && status < 300)
      const isClientError = status >= 400 && status < 500

      if (!isOk) {
        // Depth: infinity 的 4xx（例如 403）通常表示服务器不支持此模式，直接视为“不可用”，不重试
        if (isClientError) {
          await syncLog('[propfind-infinity-skip] ' + rootPath + ' status=' + status + ' (treat as unsupported, no retry)')
          return false as any
        }
        throw new Error('HTTP ' + (status || ''))
      }

      text = typeof (resp as any).text === 'function' ? await (resp as any).text() : ((resp as any).data || '')
      return true as any
    }).catch(() => false as any)
    if (!ok) return null
    const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml')
    const respNodes = Array.from(doc.getElementsByTagNameNS('*','response'))

    const map = new Map<string, FileEntry>()
    const dirsProps: { [dir: string]: { mtime?: number; etag?: string } } = {}

    for (const r of respNodes) {
      const hrefEl = (r as any).getElementsByTagNameNS?.('*','href')?.[0] as Element | undefined
      const mEl = (r as any).getElementsByTagNameNS?.('*','getlastmodified')?.[0] as Element | undefined
      const etagEl = (r as any).getElementsByTagNameNS?.('*','getetag')?.[0] as Element | undefined
      const typeEl = (r as any).getElementsByTagNameNS?.('*','resourcetype')?.[0] as Element | undefined
      const rawHref = hrefEl?.textContent || ''
      if (!rawHref) continue

      let href = rawHref
      try { href = decodeURIComponent(rawHref) } catch {}

      // 提取相对路径
      const rootUrl = new URL(joinUrl(baseUrl, rootPath))
      const itemUrl = href.startsWith('http') ? new URL(href) : new URL(href, rootUrl)
      let rel = itemUrl.pathname.replace(rootUrl.pathname, '').replace(/^\/+/, '')
      if (!rel) continue
      if (rel.startsWith('.')) continue

      const typeXml = typeEl?.outerHTML || typeEl?.innerHTML || ''
      const isDir = /<d:collection\b/i.test(typeXml) || /<collection\b/i.test(typeXml) || /\bcollection\b/i.test(typeXml) || rawHref.endsWith('/')
      const mt = mEl?.textContent ? toEpochMs(mEl.textContent) : undefined
      const etag = etagEl?.textContent ? String(etagEl.textContent).replace(/^["']|["']$/g, '') : undefined

      if (isDir) {
        dirsProps[rel] = { mtime: mt, etag }
      } else {
        if (/\.(md|markdown|txt|png|jpg|jpeg|gif|svg|pdf)$/i.test(rel)) {
          map.set(rel, { path: rel, mtime: toEpochMs(mt), size: 0, etag })
        }
      }
    }

    await syncLog(`[infinity-success] 使用 Depth:infinity 获取到 ${map.size} 个文件`)
    return { files: map, dirsProps }
  } catch (e) {
    await syncLog(`[infinity-failed] Depth:infinity 不支持，回退到递归扫描: ${(e as any)?.message || e}`)
    return null
  }
}

// 远端递归扫描（带剪枝）：
// - 根据上次保存的目录属性（mtime/etag）决定是否深入子目录
// - 若服务器未提供目录 mtime/etag，则回退为完整递归
async function listRemoteRecursively(
  baseUrl: string,
  auth: { username: string; password: string },
  rootPath: string,
  opts?: { lastDirs?: { [dir: string]: { mtime?: number; etag?: string } } }
): Promise<{ files: Map<string, FileEntry>; dirsProps: { [dir: string]: { mtime?: number; etag?: string } } }> {
  // 先尝试 Depth: infinity
  const infinityResult = await tryListRemoteInfinity(baseUrl, auth, rootPath)
  if (infinityResult) return infinityResult

  // 回退到递归扫描
  const map = new Map<string, FileEntry>()
  const dirsProps: { [dir: string]: { mtime?: number; etag?: string } } = {}
  let dirCount = 0
  let fileCount = 0

  async function walk(rel: string) {
    const full = rel ? rootPath.replace(/\/+$/,'') + '/' + rel.replace(/^\/+/, '') : rootPath

    dirCount++
    if (dirCount % 3 === 0 || fileCount % 20 === 0) {
      updateStatus(`扫描远程… 已发现 ${fileCount} 个文件，${dirCount} 个目录`)
    }

    let __filesRes: any = { files: [] }
    try {
      __filesRes = await listRemoteDir(baseUrl, auth, full)
    } catch (e) {
      await syncLog('[remote-scan-error] 列出目录失败: ' + full + ' - ' + ((e as any)?.message || e))
      __filesRes = { files: [] }
    }
    const files = __filesRes.files || []

    // 分离文件和目录
    const subDirs: Array<{ name: string; rel: string; needDive: boolean }> = []

    for (const f of files) {
      if (!f?.name) continue
      if (String(f.name).startsWith('.')) continue
      const r = rel ? rel + '/' + f.name : f.name
      if (f.isDir) {
        // 记录目录条目属性（若服务器提供）
        dirsProps[r] = { mtime: f.mtime, etag: f.etag }
        // 暂时禁用目录剪枝优化，确保检测到所有文件变化（包括重命名）
        subDirs.push({ name: f.name, rel: r, needDive: true })
      } else {
        fileCount++
        map.set(r, { path: r, mtime: toEpochMs(f.mtime), size: 0, etag: f.etag })
      }
    }

    // 并发扫描子目录 (每次最多8个)
    const DIR_CONCURRENCY = 8
    for (let i = 0; i < subDirs.length; i += DIR_CONCURRENCY) {
      const batch = subDirs.slice(i, i + DIR_CONCURRENCY)
      await Promise.all(batch.map(d => walk(d.rel)))
    }
  }
  await walk('')
  updateStatus(`远程扫描完成，共 ${fileCount} 个文件，${dirCount} 个目录`)
  return { files: map, dirsProps }
}

async function downloadFile(baseUrl: string, auth: { username: string; password: string }, remotePath: string): Promise<Uint8Array> {
  const http = await getHttpClient(); if (!http) throw new Error('no http client')
  const url = joinUrl(baseUrl, remotePath)
  const authStr = btoa(`${auth.username}:${auth.password}`)
  const headers: Record<string,string> = { Authorization: `Basic ${authStr}` }
  let u8: Uint8Array | null = null
  await withHttpRetry('[download] ' + remotePath, async () => {
    const resp = await http.fetch(url, { method: 'GET', headers, responseType: (http as any).ResponseType?.Binary })
    const ok = resp?.ok === true || (typeof resp.status === 'number' && resp.status >= 200 && resp.status < 300)
    if (!ok) throw new Error('HTTP ' + (resp?.status || ''))
    const buf: any = (typeof resp.arrayBuffer === 'function') ? await resp.arrayBuffer() : resp.data
    u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : (buf as Uint8Array)
    return true as any
  })
  if (!u8) throw new Error('download failed without data')
  return u8
}

async function uploadFile(baseUrl: string, auth: { username: string; password: string }, remotePath: string, data: Uint8Array): Promise<void> {
  const http = await getHttpClient(); if (!http) throw new Error('no http client')
  const url = joinUrl(baseUrl, remotePath)
  const authStr = btoa(`${auth.username}:${auth.password}`)
  const headers: Record<string,string> = { Authorization: `Basic ${authStr}`, 'Content-Type': 'application/octet-stream' }
  const body = (http as any).Body?.bytes ? (http as any).Body.bytes(data) : data
  await withHttpRetry('[upload] ' + remotePath, async () => {
    const resp = await http.fetch(url, { method: 'PUT', headers, body })
    const ok = resp?.ok === true || (typeof resp.status === 'number' && resp.status >= 200 && resp.status < 300)
    if (!ok) throw new Error('HTTP ' + (resp?.status || ''))
    return true as any
  })
}

async function deleteRemoteFile(baseUrl: string, auth: { username: string; password: string }, remotePath: string): Promise<void> {
  const http = await getHttpClient(); if (!http) throw new Error('no http client')
  const url = joinUrl(baseUrl, remotePath)
  const authStr = btoa(`${auth.username}:${auth.password}`)
  const headers: Record<string,string> = { Authorization: `Basic ${authStr}` }
  await withHttpRetry('[delete] ' + remotePath, async () => {
    const resp = await http.fetch(url, { method: 'DELETE', headers })
    const ok = resp?.ok === true || (typeof resp.status === 'number' && resp.status >= 200 && resp.status < 300)
    if (!ok) throw new Error('HTTP ' + (resp?.status || ''))
    return true as any
  })
}

// WebDAV 内容加密：使用 AES-GCM + PBKDF2 派生密钥
const ENC_MAGIC = 'FMDENC1'
const ENC_MAGIC_BYTES = new TextEncoder().encode(ENC_MAGIC)
const ENC_VERSION = 1

type EncryptionRuntimeConfig = {
  key: string
  salt: string
}

let _encKeyCache: { cacheKey: string; cryptoKey: CryptoKey } | null = null

function getEncryptionRuntimeConfig(cfg: WebdavSyncConfig): EncryptionRuntimeConfig | null {
  if (!cfg.encryptEnabled) return null
  const key = (cfg.encryptKey || '').trim()
  const salt = (cfg.encryptSalt || '').trim()
  if (!key || key.length < 8) return null
  if (!salt) return null
  return { key, salt }
}

async function getCryptoKeyForEncryption(encCfg: EncryptionRuntimeConfig): Promise<CryptoKey | null> {
  try {
    const cacheKey = encCfg.key + '|' + encCfg.salt
    if (_encKeyCache && _encKeyCache.cacheKey === cacheKey) return _encKeyCache.cryptoKey
    if (!(crypto as any)?.subtle) {
      console.warn('[WebDAV Sync] 当前环境不支持 WebCrypto，加密功能不可用')
      return null
    }
    const te = new TextEncoder()
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      te.encode(encCfg.key),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    )
    const saltBytes = base64ToBytes(encCfg.salt)
    const cryptoKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 100_000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    _encKeyCache = { cacheKey, cryptoKey }
    return cryptoKey
  } catch (e) {
    console.warn('[WebDAV Sync] 加密密钥派生失败', e)
    return null
  }
}

function looksLikeEncrypted(data: Uint8Array): boolean {
  if (!data || data.length <= ENC_MAGIC_BYTES.length + 1 + 12) return false
  for (let i = 0; i < ENC_MAGIC_BYTES.length; i++) {
    if (data[i] !== ENC_MAGIC_BYTES[i]) return false
  }
  return true
}

async function encryptBytesIfEnabled(data: Uint8Array, cfg: WebdavSyncConfig): Promise<Uint8Array> {
  const encCfg = getEncryptionRuntimeConfig(cfg)
  if (!encCfg) return data
  const key = await getCryptoKeyForEncryption(encCfg)
  if (!key) {
    throw new Error('WebDAV 加密已启用，但密钥派生失败')
  }
  try {
    const iv = randomBytes(12)
    const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
    const ct = new Uint8Array(ctBuf)
    const out = new Uint8Array(ENC_MAGIC_BYTES.length + 1 + iv.length + ct.length)
    out.set(ENC_MAGIC_BYTES, 0)
    out[ENC_MAGIC_BYTES.length] = ENC_VERSION
    out.set(iv, ENC_MAGIC_BYTES.length + 1)
    out.set(ct, ENC_MAGIC_BYTES.length + 1 + iv.length)
    return out
  } catch (e) {
    console.warn('[WebDAV Sync] 加密失败', e)
    throw new Error('WebDAV 同步加密失败：' + ((e as any)?.message || e))
  }
}

async function decryptBytesIfNeeded(data: Uint8Array, cfg: WebdavSyncConfig): Promise<Uint8Array> {
  const encCfg = getEncryptionRuntimeConfig(cfg)
  if (!encCfg) return data
  if (!looksLikeEncrypted(data)) return data
  const key = await getCryptoKeyForEncryption(encCfg)
  if (!key) {
    throw new Error('WebDAV 加密已启用，但密钥派生失败，无法解密')
  }
  try {
    const ivStart = ENC_MAGIC_BYTES.length + 1
    const ivEnd = ivStart + 12
    const iv = data.slice(ivStart, ivEnd)
    const ct = data.slice(ivEnd)
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    return new Uint8Array(plainBuf)
  } catch (e) {
    console.warn('[WebDAV Sync] 解密失败', e)
    throw new Error('WebDAV 同步解密失败：' + ((e as any)?.message || e))
  }
}

// WebDAV MOVE 操作：用于重命名远端文件
async function moveRemoteFile(baseUrl: string, auth: { username: string; password: string }, fromPath: string, toPath: string): Promise<void> {
  const http = await getHttpClient(); if (!http) throw new Error('no http client')
  const fromUrl = joinUrl(baseUrl, fromPath)
  const toUrl = joinUrl(baseUrl, toPath)
  const authStr = btoa(`${auth.username}:${auth.password}`)
  const headers: Record<string,string> = {
    Authorization: `Basic ${authStr}`,
    Destination: toUrl,
    Overwrite: 'T'
  }
  const resp = await http.fetch(fromUrl, { method: 'MOVE', headers })
  const ok = resp?.ok === true || (typeof resp.status === 'number' && resp.status >= 200 && resp.status < 300)
  if (!ok) throw new Error('HTTP ' + (resp?.status || ''))
}

// 同步锁：防止并发同步
let _syncInProgress = false

// 同步完成回调
let _onSyncComplete: (() => void | Promise<void>) | null = null

export function setOnSyncComplete(callback: (() => void | Promise<void>) | null) {
  _onSyncComplete = callback
}

export async function syncNow(reason: SyncReason): Promise<{ uploaded: number; downloaded: number; skipped?: boolean } | null> {
  try {
    // 检查是否已有同步在进行
    if (_syncInProgress) {
      const msg = '同步已在进行中，跳过本次请求 (reason=' + reason + ')'
      await syncLog('[skip] ' + msg)
      console.log('[WebDAV Sync]', msg)
      try { const el = document.getElementById('status'); if (el) el.textContent = '同步进行中，请稍候'; setTimeout(() => { try { if (el) el.textContent = '' } catch {} }, 1500) } catch {}
      return { uploaded: 0, downloaded: 0, skipped: true }
    }

    // 设置同步锁
    _syncInProgress = true
    await syncLog('[sync-start] 开始同步 (reason=' + reason + ')')
    console.log('[WebDAV Sync] 开始同步, reason:', reason)

    const cfg = await getWebdavSyncConfig()
    const httpWhitelist = normalizeHttpWhitelist(cfg.allowedHttpHosts)
    if (!cfg.enabled) {
      await syncLog('[skip] 同步未启用')
      console.log('[WebDAV Sync] 同步未启用')
      return { uploaded: 0, downloaded: 0, skipped: true }
    }
    const localRoot = await getActiveLibraryRoot()
    if (!localRoot) {
      await syncLog('[skip] 未选择库目录')
      console.log('[WebDAV Sync] 未选择库目录')
      updateStatus('未选择库目录，已跳过同步')
      clearStatus()
      return { uploaded: 0, downloaded: 0, skipped: true }
    }
    updateStatus('正在同步… 准备中')
    const baseUrl = (cfg.baseUrl || '').trim()
    if (!baseUrl) {
      await syncLog('[skip] 未配置 WebDAV Base URL')
      updateStatus('未配置 WebDAV 地址，已跳过同步')
      clearStatus(2000)
      return { uploaded: 0, downloaded: 0, skipped: true }
    }
    const isPlainHttp = /^http:\/\//i.test(baseUrl)
    if (isPlainHttp && !cfg.allowHttpInsecure) {
      const msg = '安全策略阻止 HTTP 明文传输，请在同步设置中允许 HTTP 后再试'
      await syncLog('[skip] ' + msg)
      updateStatus(msg)
      clearStatus(4000)
      return { uploaded: 0, downloaded: 0, skipped: true }
    }
    if (isPlainHttp && cfg.allowHttpInsecure && httpWhitelist.length > 0) {
      const targetHost = parseHostPort(baseUrl)
      if (!isHostAllowedByWhitelist(targetHost, httpWhitelist)) {
        const hostLabel = targetHost ? (targetHost.port ? `${targetHost.host}:${targetHost.port}` : targetHost.host) : baseUrl
        const msg = 'HTTP 主机未被允许：' + hostLabel
        await syncLog('[skip] ' + msg)
        updateStatus(msg)
        clearStatus(4000)
        return { uploaded: 0, downloaded: 0, skipped: true }
      }
    }
    const auth = { username: cfg.username, password: cfg.password }; await syncLog('[prep] root=' + (await getActiveLibraryRoot()) + ' remoteRoot=' + cfg.rootPath)
    try { await ensureRemoteDir(baseUrl, auth, (cfg.rootPath || '').replace(/\/+$/, '')) } catch {}

    // 获取上次同步的元数据
    const profileState = await loadSyncMetadataProfile({ localRoot, baseUrl, remoteRoot: cfg.rootPath || '/flymd' })
    await syncLog('[profile] key=' + profileState.profile.key + ' fresh=' + profileState.isFreshProfile + (profileState.legacyDetected ? ' legacy-detected' : ''))
    const forceSafePull = profileState.isFreshProfile && profileState.legacyDetected
    if (forceSafePull) {
      await syncLog('[profile] 检测到旧版同步数据且当前库没有独立配置，默认执行全量拉取以避免误删')
    }
    const lastMeta = profileState.meta
    const skipMinutes = cfg.skipRemoteScanMinutes !== undefined ? cfg.skipRemoteScanMinutes : 5
    const allowSmartSkip = reason !== 'manual' && skipMinutes > 0
    const timeSinceLastSync = Date.now() - (lastMeta.lastSyncTime || 0)
    const recentlyScanned = allowSmartSkip && timeSinceLastSync < skipMinutes * 60 * 1000

    // 使用库根快照进行快速短路（仅在 skipRemoteScanMinutes 时间窗内，且仅用于自动同步）
    try {

      updateStatus('快速检查本地变更…')
      const lastHint = await readLocalStructureHint(localRoot)
      const curHint = await quickSummarizeLocal(localRoot)

      if (curHint.totalFiles === 0) {
        await syncLog('[hint] 检测到本地为空，仍将进行远程扫描')
      } else if (lastHint && recentlyScanned) {
        const sameFiles = lastHint.totalFiles === curHint.totalFiles
        const sameDirs = lastHint.totalDirs === curHint.totalDirs
        const sameMaxMtime = Math.abs(lastHint.maxMtime - curHint.maxMtime) <= 1000
        if (sameFiles && sameDirs && sameMaxMtime) {
          await syncLog('[hint-skip] 本地结构与上次一致，且刚同步过，跳过本次同步')
          updateStatus('本地无变化，已跳过同步')
          clearStatus(2000)
          return { uploaded: 0, downloaded: 0, skipped: true }
        }
      }
    } catch (e) {
      console.warn('快速短路检查失败（忽略并继续正常流程）', e)
    }

    // 扫描本地文件
    updateStatus('正在扫描本地文件…')
    const localIdx = await scanLocal(localRoot, lastMeta)  // 传入 lastMeta 用于哈希缓存

    // 优化：检查本地是否有修改
    let hasLocalChanges = false
    for (const [path, local] of localIdx.entries()) {
      const last = lastMeta.files[path]
      if (!last || last.hash !== local.hash) {
        hasLocalChanges = true
        break
      }
    }

    // 检查是否有本地新增或删除的文件
    const localPaths = new Set(localIdx.keys())
    const lastPaths = new Set(Object.keys(lastMeta.files))
    for (const path of lastPaths) {
      if (!localPaths.has(path)) {
        hasLocalChanges = true
        break
      }
    }

    // 智能跳过远程扫描（仅在自动同步时启用）
    if (allowSmartSkip && !hasLocalChanges && recentlyScanned && localIdx.size > 0) {
      await syncLog('[skip-remote] 本地无修改且最近刚同步过(' + Math.floor(timeSinceLastSync / 1000) + '秒前)，跳过远程扫描')
      updateStatus('本地无修改，跳过同步')
      clearStatus(2000)
      return { uploaded: 0, downloaded: 0, skipped: true }
    }

    // 添加连接服务器提示
    updateStatus('正在连接 WebDAV 服务器…')
    await syncLog('[remote] 开始扫描远程文件' + (hasLocalChanges ? '（检测到本地有修改）' : '（距上次同步超过' + skipMinutes + '分钟）'))

    // 2秒后更新提示（如果还在扫描中）
    const connectionHintTimer = setTimeout(() => {
      try {
        updateStatus('连接成功，正在扫描远程文件结构…')
      } catch {}
    }, 2000)

    // 扫描远程文件（带目录剪枝）
    const remoteScan = await listRemoteRecursively(baseUrl, auth, cfg.rootPath, { lastDirs: lastMeta.dirs || {} })
    const remoteIdx = remoteScan.files

    // 清除定时器
    clearTimeout(connectionHintTimer)

    const plan: { type: 'upload' | 'download' | 'delete' | 'conflict' | 'move-remote' | 'local-deleted' | 'delete-local' | 'remote-deleted-ask'; rel: string; oldRel?: string; reason?: string }[] = []

    // 添加对比阶段提示
    updateStatus('正在对比本地和远程文件…')
    await syncLog('[compare] 开始对比文件差异')

    const allKeys = new Set<string>([...localIdx.keys(), ...remoteIdx.keys(), ...Object.keys(lastMeta.files)])

    // 重命名检测：找出"本地仅有"和"远程仅有"中可能是重命名的文件
    const localOnly = new Set<string>()
    const remoteOnly = new Set<string>()
    for (const k of allKeys) {
      if (localIdx.has(k) && !remoteIdx.has(k)) localOnly.add(k)
      if (!localIdx.has(k) && remoteIdx.has(k)) remoteOnly.add(k)
    }

    const renamedPairs = new Map<string, string>()  // oldPath -> newPath
    for (const newPath of localOnly) {
      const local = localIdx.get(newPath)
      if (!local?.hash) continue
      // 检查是否有远程文件的哈希与本地新文件的哈希相同
      for (const oldPath of remoteOnly) {
        const lastFile = lastMeta.files[oldPath]
        if (lastFile && lastFile.hash === local.hash) {
          // 找到重命名！
          await syncLog('[rename-detect] ' + oldPath + ' -> ' + newPath)
          renamedPairs.set(oldPath, newPath)
          localOnly.delete(newPath)
          remoteOnly.delete(oldPath)
          break
        }
      }
    }

    // 为重命名操作生成move-remote计划
    for (const [oldPath, newPath] of renamedPairs.entries()) {
      plan.push({ type: 'move-remote', rel: newPath, oldRel: oldPath, reason: 'renamed' })
    }

    let compareCount = 0
    const totalCompare = allKeys.size
    for (const k of allKeys) {
      compareCount++
      if (compareCount % 10 === 0) {
        const shortName = k.length > 30 ? '...' + k.substring(k.length - 27) : k
        updateStatus(`正在对比… ${shortName} (${compareCount}/${totalCompare})`)
      }

      const local = localIdx.get(k)
      const remote = remoteIdx.get(k)
      const last = lastMeta.files[k]

      // forceSafePull 模式：检测到旧版元数据但当前库没有独立配置
      // 为了绝对安全，此模式下：
      // - 不根据旧元数据推断“删除”，避免误删远端或本地文件
      // - 优先拉取“远端有、本地无”的文件（安全填坑）
      // - 对于本地和远端都存在的文件：
      //   * 若没有历史记录 → 视为有争议，完全不动
      //   * 若仅一侧相对 lastMeta 发生修改 → 视为安全单向变化，允许按常规方向同步
      //   * 若两侧都变或无法判断远端是否变化 → 视为有争议，本轮不动，留给后续正常轮次/用户决策
      if (forceSafePull) {
        // 远端有，本地无：总是安全拉取
        if (!local && remote) {
          await syncLog('[safe-mode] ' + k + ' forceSafePull: 仅拉取远端版本')
          plan.push({ type: 'download', rel: k, reason: 'safe-mode-remote' })
          continue
        }

        // 本地有，远端无：不自动上传，避免把可能已被其他设备删除的内容重新写回远端
        if (local && !remote) {
          await syncLog('[safe-mode] ' + k + ' forceSafePull: 本地存在但远端不存在，将询问用户是否上传')
          try {
            const result = await showUploadMissingRemoteDialog(k)
            if (result === 'confirm') {
              await syncLog('[safe-mode-apply] ' + k + ' forceSafePull: 用户选择上传本地文件到远端')
              plan.push({ type: 'upload', rel: k, reason: 'safe-mode-local-confirm-upload' } as any)
            } else {
              await syncLog('[safe-mode-skip] ' + k + ' forceSafePull: 用户选择不上传，仅保留本地文件')
            }
          } catch (e) {
            await syncLog('[safe-mode-error] ' + k + ' forceSafePull: 询问用户是否上传失败，将跳过此文件: ' + ((e as any)?.message || e))
          }
          continue
        }

        // 本地与远端均存在：根据 lastMeta 判断是否只有单侧变化
        if (local && remote) {
          if (!last) {
            // 没有历史记录：首次见到该文件，双方都有内容，视为有争议，完全不动
            await syncLog('[safe-mode] ' + k + ' forceSafePull: 本地与远端均存在但无历史记录，跳过自动同步以避免误覆盖')
            continue
          }

          const localHash = local.hash || ''
          const lastHash = last.hash || ''
          const localChanged = localHash !== lastHash

          let remoteChanged = false
          let remoteChangeReason = ''
          if (last.remoteEtag && remote.etag) {
            // 优先使用 ETag 判断远端变化
            remoteChanged = last.remoteEtag !== remote.etag
            if (remoteChanged) remoteChangeReason = 'etag-diff'
          } else if (last.remoteMtime && remote.mtime) {
            // 其次使用远端 mtime（考虑 clockSkewMs 容错）
            const clockSkew = Math.max(Math.abs(cfg.clockSkewMs || 0), 1000)
            remoteChanged = Math.abs(last.remoteMtime - remote.mtime) > clockSkew
            if (remoteChanged) remoteChangeReason = 'mtime-diff'
          } else {
            // 无法可靠判断远端是否变化：视为潜在争议，改为直接询问用户选择本地或远端版本
            await syncLog('[safe-mode-conflict] ' + k + ' forceSafePull: 缺少可靠远端元数据（no etag/mtime），将询问用户选择本地或远端版本')
            try {
              const result = await showConflictDialog(k)
              if (result === 'local') {
                await syncLog('[safe-mode-apply] ' + k + ' forceSafePull: 用户在无远端元数据场景下选择保留本地版本，按本地上传')
                plan.push({ type: 'upload', rel: k, reason: 'safe-mode-manual-local-no-remote-meta' } as any)
              } else if (result === 'remote') {
                await syncLog('[safe-mode-apply] ' + k + ' forceSafePull: 用户在无远端元数据场景下选择保留远端版本，按远端下载')
                plan.push({ type: 'download', rel: k, reason: 'safe-mode-manual-remote-no-remote-meta' } as any)
              } else {
                await syncLog('[safe-mode-skip] ' + k + ' forceSafePull: 用户在无远端元数据场景下取消操作，跳过此文件')
              }
            } catch (e) {
              await syncLog('[safe-mode-error] ' + k + ' forceSafePull: 询问用户选择本地或远端版本失败，将跳过此文件: ' + ((e as any)?.message || e))
            }
            continue
          }

          const changedCount = (localChanged ? 1 : 0) + (remoteChanged ? 1 : 0)
          if (changedCount === 0) {
            // 双方都未变化：无需动作
            continue
          }

          if (changedCount > 1) {
            // 双方都变：潜在冲突，直接弹出冲突对话框让用户选择
            await syncLog('[safe-mode-conflict] ' + k + ' forceSafePull: 检测到本地与远端都已修改，将询问用户选择本地或远端版本')
            try {
              const result = await showConflictDialog(k)
              if (result === 'local') {
                await syncLog('[safe-mode-apply] ' + k + ' forceSafePull: 用户在双向修改场景下选择保留本地版本，按本地上传')
                plan.push({ type: 'upload', rel: k, reason: 'safe-mode-manual-local-both-modified' } as any)
              } else if (result === 'remote') {
                await syncLog('[safe-mode-apply] ' + k + ' forceSafePull: 用户在双向修改场景下选择保留远端版本，按远端下载')
                plan.push({ type: 'download', rel: k, reason: 'safe-mode-manual-remote-both-modified' } as any)
              } else {
                await syncLog('[safe-mode-skip] ' + k + ' forceSafePull: 用户在双向修改场景下取消操作，跳过此文件')
              }
            } catch (e) {
              await syncLog('[safe-mode-error] ' + k + ' forceSafePull: 询问用户选择本地或远端版本失败，将跳过此文件: ' + ((e as any)?.message || e))
            }
            continue
          }

          // 仅一侧变化：视为安全单向同步（无需再次询问）
          if (localChanged) {
            await syncLog('[safe-mode-apply] ' + k + ' forceSafePull: 仅检测到本地修改，按本地上传')
            plan.push({ type: 'upload', rel: k, reason: 'safe-mode-local-modified' })
          } else if (remoteChanged) {
            await syncLog('[safe-mode-apply] ' + k + ' forceSafePull: 仅检测到远端修改，按远端下载')
            plan.push({ type: 'download', rel: k, reason: 'safe-mode-remote-modified' })
          }
          continue
        }

        // 其余情况（本地与远端都不存在）无需处理
      }

      // 情况1：本地有，远程无
      if (local && !remote) {
        if (last) {
          // 上次同步过，现在远程没有了
          // 检查本地文件是否已修改（通过哈希比对）
          const localHash = local.hash || ''
          const lastHash = last.hash || ''
          const localUnchanged = localHash === lastHash

          // 根据localDeleteStrategy配置处理
          const strategy = cfg.localDeleteStrategy || 'auto'

          if (strategy === 'keep') {
            // 策略：始终保留本地文件
            await syncLog('[keep-local] ' + k + ' 远程未找到，根据策略保留本地文件')
          } else if (strategy === 'ask') {
            // 策略：询问用户
            await syncLog('[detect] ' + k + ' 远程未找到，将询问用户如何处理')
            plan.push({ type: 'remote-deleted-ask', rel: k, reason: 'remote-deleted' } as any)
          } else {
            // 策略：auto（默认）
            if (localUnchanged) {
              // 本地未改变，远程删除了 → 安全删除本地文件
              // 这种情况包括：1) 其他设备删除了文件  2) 其他设备移动了文件（MOVE操作会删除旧路径）
              await syncLog('[infer-remote-deleted] ' + k + ' 远程已删除且本地未修改，将删除本地文件')
              plan.push({ type: 'delete-local', rel: k, reason: 'remote-deleted' })
            } else {
              // 本地已改变，远程删除了 → 可能是冲突，为安全起见保留本地文件
              await syncLog('[warn] ' + k + ' 远程未找到但本地已修改，为了安全不删除本地文件')
              // 可以考虑上传本地修改，但这里保守处理，只记录警告
            }
          }
        } else {
          // 上次没同步过 → 本地新增，上传
          plan.push({ type: 'upload', rel: k, reason: 'local-new' })
        }
      }
      // 情况2：本地无，远程有
      else if (!local && remote) {
        if (last) {
          // 上次同步过，现在本地没有了 → 用户可能删除了本地文件
          // 询问用户是否同步删除远程文件
          await syncLog('[detect] ' + k + ' 本地文件已被删除，将询问用户如何处理')
          plan.push({ type: 'local-deleted', rel: k, reason: 'local-deleted' } as any)
        } else {
          // 上次没同步过 → 远程新增，下载
          plan.push({ type: 'download', rel: k, reason: 'remote-new' })
        }
      }
      // 情况3：本地和远程都有
      else if (local && remote) {
        // 没有历史元数据：这是首次在当前设备看到该文件，本地和远程都有，视为潜在冲突
        if (!last) {
          await syncLog('[conflict-first-sync] ' + k + ' 本地和远程均存在但无历史记录，视为首次同步冲突')
          plan.push({ type: 'conflict', rel: k, reason: 'first-sync' })
          continue
        }

        const localHash = local.hash || ''
        const lastHash = last.hash || ''

        // 使用 ETag 或 mtime 判断远程是否变化（避免下载）
        let remoteChanged = false
        let remoteChangeReason = ''
        if (last.remoteEtag && remote.etag) {
          // 优先使用 ETag
          remoteChanged = last.remoteEtag !== remote.etag
          if (remoteChanged) remoteChangeReason = 'etag-diff'
        } else if (last.remoteMtime && remote.mtime) {
          // 其次使用远程 mtime（考虑 clockSkewMs 容错）
          const clockSkew = Math.max(Math.abs(cfg.clockSkewMs || 0), 1000)
          remoteChanged = Math.abs(last.remoteMtime - remote.mtime) > clockSkew
          if (remoteChanged) remoteChangeReason = 'mtime-diff'
        } else {
          // 兜底：缺少可靠远端元数据时不依赖时间判断远端变化，避免错误假定“远端未变”
          remoteChanged = false
          remoteChangeReason = 'no-remote-meta-fallback'
        }

        const localChanged = localHash !== lastHash

        // 如果都没变化，跳过
        if (!localChanged && !remoteChanged) {
          continue
        }

        // 注意：之前这里有一个 skip-download 优化，当本地未变化且远程仅 mtime 变化时跳过下载
        // 但这个优化有bug：当其他设备上传新内容时，本地确实没变，但远程内容真的变了
        // 此时不应该跳过下载。因此移除这个优化，改为正常下载后比较内容

        // 记录详细判断信息
        if (localChanged || remoteChanged) {
          await syncLog(`[compare-detail] ${k} | local: ${localChanged ? 'changed' : 'unchanged'} | remote: ${remoteChanged ? 'changed(' + remoteChangeReason + ')' : 'unchanged'} | lastHash: ${lastHash.substring(0, 8)}... | localHash: ${localHash.substring(0, 8)}...`)
        }

        // 如果两边都变化了，判断为冲突
        if (localChanged && remoteChanged) {
          plan.push({ type: 'conflict', rel: k, reason: 'both-modified' })
          await syncLog('[conflict!] ' + k + ' 本地和远程都已修改')
        } else if (localChanged) {
          // 只有本地改了 → 上传
          plan.push({ type: 'upload', rel: k, reason: 'local-modified' })
        } else if (remoteChanged) {
          // 只有远程改了 → 下载
          plan.push({ type: 'download', rel: k, reason: 'remote-modified' })
        }
      }
    }

    updateStatus(`对比完成，发现 ${plan.length} 个变化`)
    await syncLog('[compare-done] 发现 ' + plan.length + ' 个需要同步的操作')

    // 设置 deadline：只针对上传/下载循环，不包括扫描时间
    // 关闭前同步给更多时间（最多60秒），让同步能完整完成
    const deadline = Date.now() + (reason === 'shutdown' ? Math.min(60000, cfg.timeoutMs) : cfg.timeoutMs)
    let __processed = 0; let __total = plan.length;
    let __fail = 0; let __lastErr = ""
    updateStatus(`正在同步… 0/${__total}`)
    let up = 0, down = 0, del = 0, conflicts = 0, moves = 0
    type SummaryAction = 'upload' | 'download' | 'delete' | 'update'
    const actionSummaries: { type: SummaryAction; rel: string }[] = []
    const recordAction = (type: SummaryAction, rel: string) => {
      if (!rel) return
      actionSummaries.push({ type, rel })
    }

    // 全量覆盖：初始化 newMeta 时复制 lastMeta.files，保留未变化的条目
    const newMeta: SyncMetadata = {
      files: { ...lastMeta.files },  // 复制所有旧条目
      lastSyncTime: Date.now(),
      dirs: { ...(lastMeta.dirs || {}), ...((remoteScan as any)?.dirsProps || {}) }
    }

    // 并发控制：将任务分组并发执行
    const CONCURRENCY = 10  // 同时处理10个文件
    const processTask = async (act: typeof plan[0]) => {
      if (Date.now() > deadline) {
        await syncLog('[timeout] 超时中断')
        return { success: false, timeout: true }
      }
      try {
        if (act.type === 'move-remote') {
          // 处理重命名：使用 WebDAV MOVE
          await syncLog('[move-remote] ' + (act.oldRel || '') + ' -> ' + act.rel)
          const oldRemotePath = cfg.rootPath.replace(/\/+$/,'') + '/' + encodePath(act.oldRel || '')
          const newRemotePath = cfg.rootPath.replace(/\/+$/,'') + '/' + encodePath(act.rel)
          // 确保目标目录存在
          const relPath = encodePath(act.rel)
          const relDir = relPath.split('/').slice(0, -1).join('/')
          const remoteDir = (cfg.rootPath || '').replace(/\/+$/, '') + (relDir ? '/' + relDir : '')
          await ensureRemoteDir(baseUrl, auth, remoteDir)
          // 执行 MOVE
          await moveRemoteFile(baseUrl, auth, oldRemotePath, newRemotePath)
          await syncLog('[ok] move-remote ' + (act.oldRel || '') + ' -> ' + act.rel)
          // 更新元数据
          const local = localIdx.get(act.rel)
          if (local) {
            const full = localRoot + (localRoot.includes('\\') ? '\\' : '/') + act.rel.replace(/\//g, localRoot.includes('\\') ? '\\' : '/')
            const meta = await stat(full)
            newMeta.files[act.rel] = {
              hash: local.hash || '',
              mtime: toEpochMs((meta as any)?.modifiedAt || (meta as any)?.mtime || (meta as any)?.mtimeMs),
              size: Number((meta as any)?.size || 0),
              syncTime: Date.now(),
              remoteMtime: local.mtime,
              remoteEtag: undefined
            }
          }
          // 删除旧路径的元数据
          if (act.oldRel) delete newMeta.files[act.oldRel]
          recordAction('update', act.rel)
        } else if (act.type === 'conflict') {
          // 处理冲突：根据策略自动选择或询问用户
          await syncLog('[conflict] ' + act.rel + ' - 策略: ' + cfg.conflictStrategy)

          let chooseLocal = false  // 默认选择远程

          if (cfg.conflictStrategy === 'ask') {
            // 询问用户
            const result = await showConflictDialog(act.rel)
            if (result === 'cancel') {
              // 用户取消，跳过此文件
              await syncLog('[conflict-cancel] ' + act.rel + ' 用户取消操作')
              return { success: true, type: act.type }
            }
            chooseLocal = result === 'local'
          } else if (cfg.conflictStrategy === 'newest') {
            // 按时间戳选择较新者
            const local = localIdx.get(act.rel)
            const remote = remoteIdx.get(act.rel)
            const lm = Number(local?.mtime || 0)
            const rm = Number(remote?.mtime || 0)
            chooseLocal = lm > rm
            await syncLog('[conflict-auto] ' + act.rel + ' 选择较新者: ' + (chooseLocal ? '本地' : '远程'))
          } else if (cfg.conflictStrategy === 'last-wins') {
            // 总是选择远程（最后写入者获胜）
            chooseLocal = false
            await syncLog('[conflict-auto] ' + act.rel + ' 选择远程（last-wins）')
          }

          if (chooseLocal) {
            // 保留本地 → 上传
            await syncLog('[conflict-resolve] ' + act.rel + ' 保留本地版本')
            const full = localRoot + (localRoot.includes('\\') ? '\\' : '/') + act.rel.replace(/\//g, localRoot.includes('\\') ? '\\' : '/')
            const buf = await readFile(full as any)
            const encBuf = await encryptBytesIfEnabled(buf as any, cfg)
            const relPath = encodePath(act.rel)
            const relDir = relPath.split('/').slice(0, -1).join('/')
            const remoteDir = (cfg.rootPath || '').replace(/\/+$/, '') + (relDir ? '/' + relDir : '')
            await ensureRemoteDir(baseUrl, auth, remoteDir)
            await uploadFile(baseUrl, auth, cfg.rootPath.replace(/\/+$/,'') + '/' + encodePath(act.rel), encBuf as any)
              // 记录到元数据 - 使用扫描时的哈希
            const meta = await stat(full)
            const local = localIdx.get(act.rel)
            const remote = remoteIdx.get(act.rel)
            newMeta.files[act.rel] = {
              hash: local?.hash || '',  // 使用扫描时的哈希
              mtime: toEpochMs((meta as any)?.modifiedAt || (meta as any)?.mtime || (meta as any)?.mtimeMs),
              size: Number((meta as any)?.size || 0),
              syncTime: Date.now(),
              remoteMtime: toEpochMs((meta as any)?.modifiedAt || (meta as any)?.mtime || (meta as any)?.mtimeMs),
              remoteEtag: remote?.etag
            }
            recordAction('upload', act.rel)
          } else {
            // 保留远程 → 下载
            await syncLog('[conflict-resolve] ' + act.rel + ' 保留远程版本')
            const raw = await downloadFile(baseUrl, auth, cfg.rootPath.replace(/\/+$/,'') + '/' + encodePath(act.rel))
            const data = await decryptBytesIfNeeded(raw, cfg)
            const hash = await calculateFileHash(data as any)
            const full = localRoot + (localRoot.includes('\\') ? '\\' : '/') + act.rel.replace(/\//g, localRoot.includes('\\') ? '\\' : '/')
            const dir = full.split(/\\|\//).slice(0, -1).join(localRoot.includes('\\') ? '\\' : '/')
            if (!(await exists(dir as any))) { try { await mkdir(dir as any, { recursive: true } as any) } catch {} }
            await writeFile(full as any, data as any)
              // 记录到元数据
            const meta = await stat(full)
            const remote = remoteIdx.get(act.rel)
            newMeta.files[act.rel] = {
              hash,
              mtime: toEpochMs((meta as any)?.modifiedAt || (meta as any)?.mtime || (meta as any)?.mtimeMs),
              size: Number((meta as any)?.size || 0),
              syncTime: Date.now(),
              remoteMtime: remote?.mtime,
              remoteEtag: remote?.etag
            }
            recordAction('download', act.rel)
          }
        } else if (act.type === 'download') {
          if (act.reason === 'remote-deleted') {
            // 不再自动删除本地文件，只记录警告
            await syncLog('[skip-delete-local] ' + act.rel + ' 为了安全，不自动删除本地文件')
            // 从元数据中移除（但不删除实际文件）
          } else {
            // 正常下载
            await syncLog('[download] ' + act.rel + ' (' + act.reason + ')')
            const raw = await downloadFile(baseUrl, auth, cfg.rootPath.replace(/\/+$/,'') + '/' + encodePath(act.rel))
            const data = await decryptBytesIfNeeded(raw, cfg)
            const hash = await calculateFileHash(data as any)
            const full = localRoot + (localRoot.includes('\\') ? '\\' : '/') + act.rel.replace(/\//g, localRoot.includes('\\') ? '\\' : '/')
            const dir = full.split(/\\|\//).slice(0, -1).join(localRoot.includes('\\') ? '\\' : '/')
            if (!(await exists(dir as any))) { try { await mkdir(dir as any, { recursive: true } as any) } catch {} }
            await writeFile(full as any, data as any)
              await syncLog('[ok] download ' + act.rel)
            // 记录到元数据
            const meta = await stat(full)
            const remote = remoteIdx.get(act.rel)
            newMeta.files[act.rel] = {
              hash,
              mtime: toEpochMs((meta as any)?.modifiedAt || (meta as any)?.mtime || (meta as any)?.mtimeMs),
              size: Number((meta as any)?.size || 0),
              syncTime: Date.now(),
              remoteMtime: remote?.mtime,  // 保存远端mtime
              remoteEtag: remote?.etag     // 保存远端etag
            }
            recordAction('download', act.rel)
          }
        } else if (act.type === 'upload') {
          await syncLog('[upload] ' + act.rel + ' (' + act.reason + ')')
          const full = localRoot + (localRoot.includes('\\') ? '\\' : '/') + act.rel.replace(/\//g, localRoot.includes('\\') ? '\\' : '/')
          const buf = await readFile(full as any)
          const encBuf = await encryptBytesIfEnabled(buf as any, cfg)
          const relPath = encodePath(act.rel)
          const relDir = relPath.split('/').slice(0, -1).join('/')
          const remoteDir = (cfg.rootPath || '').replace(/\/+$/, '') + (relDir ? '/' + relDir : '')
          await ensureRemoteDir(baseUrl, auth, remoteDir)
          await uploadFile(baseUrl, auth, cfg.rootPath.replace(/\/+$/,'') + '/' + encodePath(act.rel), encBuf as any)
          await syncLog('[ok] upload ' + act.rel)
          // 记录到元数据 - 使用扫描时的哈希
          const meta = await stat(full)
          const local = localIdx.get(act.rel)
          newMeta.files[act.rel] = {
            hash: local?.hash || '',  // 使用扫描时的哈希,不重新计算
            mtime: toEpochMs((meta as any)?.modifiedAt || (meta as any)?.mtime || (meta as any)?.mtimeMs),
            size: Number((meta as any)?.size || 0),
            syncTime: Date.now(),
            remoteMtime: local?.mtime,
            remoteEtag: undefined
          }
          recordAction('upload', act.rel)
        } else if (act.type === 'local-deleted') {
          // 处理本地文件被删除的情况：根据配置决定是否询问用户
          await syncLog('[local-deleted] ' + act.rel + ' 本地文件已被删除，处理中...')
          try {
            let userChoice = false

            // 检查是否需要用户确认
            if (cfg.confirmDeleteRemote !== false) {
              // 需要确认：询问用户
              await syncLog('[local-deleted] ' + act.rel + ' 询问用户如何处理')
              try {
                const result = await showLocalDeleteDialog(act.rel)
                userChoice = result === 'confirm'
              } catch (e) {
                // 自定义对话框失败时兜底使用系统对话框，避免静默跳过
                await syncLog('[local-deleted-dialog-error] ' + act.rel + ' 自定义对话框失败，将回退到系统对话框: ' + ((e as any)?.message || e))
                try {
                  const ok = await ask(
                    '文件：' + act.rel + '\n\n此文件在上次同步后被本地删除。\n是否同步删除远程文件？\n\n选择“是”将删除远程文件，选择“否”将从远程恢复到本地。',
                    { title: 'WebDAV 同步 - 本地删除确认', kind: 'warning' } as any
                  )
                  userChoice = !!ok
                } catch (e2) {
                  await syncLog('[local-deleted-dialog-fatal] ' + act.rel + ' 所有对话框均失败，默认保留远程文件: ' + ((e2 as any)?.message || e2))
                  userChoice = false
                }
              }
            } else {
              // 不需要确认：直接删除远程文件
              await syncLog('[local-deleted] ' + act.rel + ' 自动删除远程文件（已禁用确认）')
              userChoice = true
            }

            if (userChoice) {
              // 用户选择删除远程文件
              await syncLog('[local-deleted-action] ' + act.rel + ' 用户选择删除远程文件')
              await deleteRemoteFile(baseUrl, auth, cfg.rootPath.replace(/\/+$/,'') + '/' + encodePath(act.rel))
                  await syncLog('[ok] delete-remote ' + act.rel)
              // 从元数据中移除
              delete newMeta.files[act.rel]
              recordAction('delete', act.rel)
            } else {
              // 用户选择从远程恢复
              await syncLog('[local-deleted-action] ' + act.rel + ' 用户选择从远程恢复')
              const raw = await downloadFile(baseUrl, auth, cfg.rootPath.replace(/\/+$/,'') + '/' + encodePath(act.rel))
              const data = await decryptBytesIfNeeded(raw, cfg)
              const hash = await calculateFileHash(data as any)
              const full = localRoot + (localRoot.includes('\\') ? '\\' : '/') + act.rel.replace(/\//g, localRoot.includes('\\') ? '\\' : '/')
              const dir = full.split(/\\|\//).slice(0, -1).join(localRoot.includes('\\') ? '\\' : '/')
              if (!(await exists(dir as any))) { try { await mkdir(dir as any, { recursive: true } as any) } catch {} }
              await writeFile(full as any, data as any)
                  await syncLog('[ok] recover ' + act.rel)
              // 记录到元数据
              const meta = await stat(full)
              const remote = remoteIdx.get(act.rel)
              newMeta.files[act.rel] = {
                hash,
                mtime: toEpochMs((meta as any)?.modifiedAt || (meta as any)?.mtime || (meta as any)?.mtimeMs),
                size: Number((meta as any)?.size || 0),
                syncTime: Date.now(),
                remoteMtime: remote?.mtime,
                remoteEtag: remote?.etag
              }
              recordAction('download', act.rel)
            }
          } catch (e) {
            await syncLog('[local-deleted-error] ' + act.rel + ' 处理失败: ' + ((e as any)?.message || e))
          }
        } else if (act.type === 'delete') {
          // 不再自动删除远程文件，只记录警告
          await syncLog('[skip-delete-remote] ' + act.rel + ' 为了安全，不自动删除远程文件')
          // 从元数据中移除（但不删除实际文件）
        } else if (act.type === 'delete-local') {
          // 删除本地文件（通常是因为远程已删除且本地未修改）
          await syncLog('[delete-local] ' + act.rel + ' 删除本地文件（远程已删除）')
          try {
            const full = localRoot + (localRoot.includes('\\') ? '\\' : '/') + act.rel.replace(/\//g, localRoot.includes('\\') ? '\\' : '/')
            // 检查文件是否存在
            if (await exists(full as any)) {
              await remove(full as any)
              await syncLog('[ok] delete-local ' + act.rel)
            } else {
              await syncLog('[skip] delete-local ' + act.rel + ' 文件不存在')
            }
            // 从元数据中移除
            delete newMeta.files[act.rel]
            recordAction('delete', act.rel)
          } catch (e) {
            await syncLog('[fail] delete-local ' + act.rel + ' : ' + ((e as any)?.message || e))
            throw e  // 继续抛出错误，让外层捕获
          }
        } else if (act.type === 'remote-deleted-ask') {
          // 远程文件被删除，询问用户如何处理本地文件
          await syncLog('[remote-deleted-ask] ' + act.rel + ' 远程已删除，询问用户如何处理')
          try {
            const result = await showRemoteDeleteDialog(act.rel)
            const userChoice = result === 'confirm'

            if (userChoice) {
              // 用户选择删除本地文件
              await syncLog('[remote-deleted-ask-action] ' + act.rel + ' 用户选择删除本地文件')
              const full = localRoot + (localRoot.includes('\\') ? '\\' : '/') + act.rel.replace(/\//g, localRoot.includes('\\') ? '\\' : '/')
              if (await exists(full as any)) {
                await remove(full as any)
                await syncLog('[ok] delete-local ' + act.rel)
              }
              // 从元数据中移除
              delete newMeta.files[act.rel]
              recordAction('delete', act.rel)
            } else {
              // 用户选择保留本地文件
              await syncLog('[remote-deleted-ask-action] ' + act.rel + ' 用户选择保留本地文件')
              // 保留元数据不变
            }
          } catch (e) {
            await syncLog('[remote-deleted-ask-error] ' + act.rel + ' 处理失败: ' + ((e as any)?.message || e))
          }
        }
        return { success: true, type: act.type }
      } catch (e) {
        console.warn('sync step failed', act, e)
        try { await syncLog('[fail] ' + act.type + ' ' + act.rel + ' : ' + ((e as any)?.message || e)) } catch {}
        return { success: false, error: e }
      }
    }

    // 并发执行任务
    for (let i = 0; i < plan.length; i += CONCURRENCY) {
      const batch = plan.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(act => processTask(act)))

      for (let j = 0; j < results.length; j++) {
        const result = results[j]
        const act = batch[j]

        if (result.timeout) {
          await syncLog('[timeout] 超时中断，已完成 ' + __processed + '/' + __total + '，剩余 ' + (plan.length - __processed) + ' 个任务未完成')
          await syncLog('[timeout] 将保存已完成任务的元数据，下次同步将继续处理剩余文件')
          break
        }

        if (!result.success) {
          __fail++
          try { __lastErr = String((result as any).error?.message || (result as any).error || __lastErr) } catch {}
          updateStatus(`同步中… ${__processed}/${__total} (失败 ${__fail})`)
        } else {
          // 更新计数器
          if (result.type === 'upload') up++
          else if (result.type === 'download') down++
          else if (result.type === 'move-remote') moves++
          else if (result.type === 'delete') del++
          else if (result.type === 'conflict') conflicts++
        }

        __processed++

        // 更新状态显示实际操作（显示文件名，不要太长）
        const shortName = act.rel.length > 35 ? '...' + act.rel.substring(act.rel.length - 32) : act.rel
        const actionEmoji = act.type === 'upload' ? '↑' : act.type === 'download' ? '↓' : act.type === 'move-remote' ? '↔' : '✗'
        updateStatus(`${actionEmoji} ${shortName} (${__processed}/${__total})`)

        // 每10个文件输出一次进度日志
        if (__processed % 10 === 0) {
          await syncLog(`[progress] 已处理 ${__processed}/${__total} 个文件，上传${up} 下载${down} 移动${moves} 冲突${conflicts}`)
        }
      }

      if (results.some(r => r.timeout)) break
    }

    // 保存同步元数据
    await syncLog('[save-meta] 正在保存元数据，共 ' + Object.keys(newMeta.files).length + ' 个文件记录')
    await saveSyncMetadata(newMeta, profileState.profile)
    await syncLog('[save-meta] 元数据保存完成')

    // 同步完成后，刷新并保存库根快照，供下次快速短路判断
    try {
      const postHint = await quickSummarizeLocal(localRoot)
      await writeLocalStructureHint(localRoot, postHint)
      await syncLog('[save-hint] 已更新本地结构快照')
    } catch {}

    try {
      let msg = `同步完成（`
      if (up > 0) msg += `↑${up} `
      if (down > 0) msg += `↓${down} `
      if (moves > 0) msg += `↔${moves} `
      if (del > 0) msg += `✗${del} `
      if (conflicts > 0) msg += `⚠${conflicts} `
      msg += `）`

      if (actionSummaries.length > 0) {
        const labelMap: Record<SummaryAction, string> = {
          upload: '上传远程',
          download: '下载本地',
          delete: '删除文档',
          update: '同步更新'
        }
        const trimRel = (rel: string) => rel.length > 35 ? '...' + rel.slice(-32) : rel
        const detailItems: string[] = []
        const maxItems = 5
        for (const item of actionSummaries.slice(0, maxItems)) {
          detailItems.push(`${labelMap[item.type]}：${trimRel(item.rel)}`)
        }
        if (actionSummaries.length > maxItems) {
          detailItems.push('其余同步内容请查看同步日志')
        }
        msg += ' ' + detailItems.join(' / ')
      }

      updateStatus(msg)
      clearStatus()
    } catch {}
    await syncLog('[done] up=' + up + ' down=' + down + ' moves=' + moves + ' del=' + del + ' conflicts=' + conflicts + ' total=' + __total);
    if (_onSyncComplete) {
      try { await _onSyncComplete() } catch (e) { console.warn('[WebDAV Sync] 回调执行失败', e) }
    }
    return { uploaded: up, downloaded: down }
  } catch (e) { try { await syncLog('[error] ' + ((e as any)?.message || e)) } catch {}
    console.warn('sync failed', e)
    updateStatus('同步失败：' + ((e as any)?.message || '未知错误'))
    clearStatus(3000)
    return null
  } finally {
    // 释放同步锁
    _syncInProgress = false
    await syncLog('[sync-end] 同步结束')
  }
}

export async function initWebdavSync(): Promise<void> {
  try {
    const cfg = await getWebdavSyncConfig()
    // F5 快捷键 - 改进：防止浏览器默认刷新行为
    try {
      document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'F5') {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          // 延迟执行，避免事件冲突
          setTimeout(() => {
            void syncNow('manual')
          }, 100)
        }
      }, { capture: true })  // 使用捕获阶段，优先拦截
    } catch {}

    // 启动后触发一次
    if (cfg.enabled && cfg.onStartup) { setTimeout(() => { void syncNow('startup') }, 600) }

    // 关闭前同步 - 改进：阻止关闭，隐藏窗口，后台同步完成后退出
    try {
      const appWin = getCurrentWindow()
      appWin.onCloseRequested(async (event) => {
        try {
          // 若有未保存更改，交由主入口的关闭询问处理
          const isDirty = !!((globalThis as any)?.flymdIsDirty?.())
          if (isDirty) {
            event.preventDefault()
            return
          }

          const c = await getWebdavSyncConfig()
          if (c.enabled && c.onShutdown) {
            // 阻止立即关闭
            event.preventDefault()

            await syncLog('[shutdown] 关闭前同步已启用，窗口将隐藏至后台')
            console.log('[WebDAV Sync] 关闭前同步开始，窗口隐藏')

            // 隐藏窗口到后台
            try {
              await appWin.hide()
              updateStatus('后台同步中，完成后将自动退出...')
            } catch (e) {
              console.warn('隐藏窗口失败:', e)
            }

            // 执行同步
            const result = await syncNow('shutdown')

            await syncLog('[shutdown] 同步完成，准备退出程序')
            console.log('[WebDAV Sync] 同步完成，退出程序')

            // 同步完成后真正退出
            try {
              // 短暂延迟确保日志写入完成
              await new Promise(resolve => setTimeout(resolve, 500))
              await appWin.destroy()
            } catch (e) {
              console.warn('退出程序失败:', e)
              // 如果 destroy 失败，尝试 close
              try {
                await appWin.close()
              } catch {}
            }
          }
        } catch (e) {
          console.error('关闭前同步出错:', e)
          await syncLog('[shutdown-error] ' + ((e as any)?.message || e))
          // 出错时也要退出，不能卡住
          try {
            await getCurrentWindow().destroy()
          } catch {}
        }
      })
    } catch (e) {
      console.warn('注册关闭事件失败:', e)
    }
  } catch {}
}

export async function openWebdavSyncDialog(): Promise<void> {
  const overlayId = 'sync-overlay'
  let overlay = document.getElementById(overlayId) as HTMLDivElement | null
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = overlayId
    overlay.className = 'upl-overlay hidden'
    overlay.innerHTML = `
      <div class="upl-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-title">
        <div class="upl-header">
          <div id="sync-title">${t('sync.title')}</div>
          <button id="sync-close" class="about-close" title="${t('about.close')}">×</button>
        </div>
        <form class="upl-body" id="sync-form">
          <div class="upl-grid">
            <div class="upl-section-title">${t('sync.section.basic')}</div>
            <div class="sync-toggles">
              <div class="item">
                <span class="lbl">${t('sync.enable')}</span>
                <label class="switch" for="sync-enabled">
                  <input id="sync-enabled" type="checkbox"/>
                  <span class="trk"></span><span class="kn"></span>
                </label>
              </div>
              <div class="item">
                <span class="lbl">${t('sync.onstartup')}</span>
                <label class="switch" for="sync-onstartup">
                  <input id="sync-onstartup" type="checkbox"/>
                  <span class="trk"></span><span class="kn"></span>
                </label>
              </div>
              <div class="item">
                <span class="lbl">${t('sync.onshutdown')}</span>
                <label class="switch" for="sync-onshutdown">
                  <input id="sync-onshutdown" type="checkbox"/>
                  <span class="trk"></span><span class="kn"></span>
                </label>
              </div>
              <div class="item">
                <span class="lbl">${t('sync.allowHttp')}</span>
                <label class="switch" for="sync-allow-http">
                  <input id="sync-allow-http" type="checkbox"/>
                  <span class="trk"></span><span class="kn"></span>
                </label>
              </div>
              <div class="item">
                <span class="lbl">${t('sync.encrypt.enable')}</span>
                <label class="switch" for="sync-encrypt-enabled">
                  <input id="sync-encrypt-enabled" type="checkbox"/>
                  <span class="trk"></span><span class="kn"></span>
                </label>
              </div>
            </div>
            <div class="upl-hint warn pad-1ch sync-shutdown-warn hidden" style="margin-top: 8px;">
              ${t('sync.warn.onshutdown')}
            </div>
            <div class="upl-hint warn pad-1ch sync-http-warn hidden" style="margin-top: 6px;">
              ${t('sync.allowHttp.warn')}
            </div>

            <label for="sync-encrypt-key" class="sync-encrypt-only hidden">${t('sync.encrypt.key')}</label>
            <div class="upl-field sync-encrypt-only hidden">
              <input id="sync-encrypt-key" type="password" placeholder="${t('sync.encrypt.key.placeholder')}"/>
              <div class="upl-hint">${t('sync.encrypt.key.hint')}</div>
            </div>
            <div class="upl-hint warn pad-1ch sync-encrypt-warn sync-encrypt-only hidden" style="margin-top: 6px;">
              ${t('sync.encrypt.warn')}
            </div>
            <label class="sync-http-hosts hidden">${t('sync.allowHttp.hosts')}</label>
            <div class="upl-field sync-http-hosts hidden">
              <div id="sync-http-hosts-list" style="display: flex; flex-direction: column; gap: 6px;"></div>
            </div>

            <label for="sync-timeout">${t('sync.timeout.label')}</label>
            <div class="upl-field">
              <input id="sync-timeout" type="number" min="1000" step="1000" placeholder="120000"/>
              <div class="upl-hint">${t('sync.timeout.suggest')}</div>
            </div>

            <label for="sync-conflict-strategy">${t('sync.conflict')}</label>
            <div class="upl-field">
              <select id="sync-conflict-strategy" style="width: 100%; padding: 8px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; background: var(--input-bg, #fff); color: var(--text-color, #333); font-size: 14px;">
                <option value="newest">${t('sync.conflict.newest')}</option>
                <option value="ask">${t('sync.conflict.ask')}</option>
                <option value="last-wins">${t('sync.conflict.remote')}</option>
              </select>
              <div class="upl-hint">${t('sync.conflict.hint')}</div>
            </div>

            <label for="sync-local-delete-strategy">${t('sync.localDelete')}</label>
            <div class="upl-field">
              <select id="sync-local-delete-strategy" style="width: 100%; padding: 8px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; background: var(--input-bg, #fff); color: var(--text-color, #333); font-size: 14px;">
                <option value="auto">${t('sync.localDelete.auto')}</option>
                <option value="ask">${t('sync.localDelete.ask')}</option>
                <option value="keep">${t('sync.localDelete.keep')}</option>
              </select>
              <div class="upl-hint">${t('sync.localDelete.hint')}</div>
            </div>

            <label for="sync-confirm-delete-remote">${t('sync.confirmDeleteRemote')}</label>
            <div class="upl-field">
              <div class="sync-toggles" style="margin: 0;">
                <div class="item">
                  <span class="lbl">${t('sync.confirmDeleteRemote.toggle')}</span>
                  <label class="switch" for="sync-confirm-delete-remote">
                    <input id="sync-confirm-delete-remote" type="checkbox"/>
                    <span class="trk"></span><span class="kn"></span>
                  </label>
                </div>
              </div>
              <div class="upl-hint">${t('sync.confirmDeleteRemote.hint')}</div>
            </div>

            <label for="sync-skip-minutes">${t('sync.smartSkip')}</label>
            <div class="upl-field">
              <input id="sync-skip-minutes" type="number" min="0" step="1" placeholder="5"/>
              <div class="upl-hint">${t('sync.smartSkip.hint')}</div>
            </div>

            <div class="upl-section-title">${t('sync.server')}</div>
            <label for="sync-baseurl">Base URL</label>
            <div class="upl-field">
              <input id="sync-baseurl" type="url" placeholder="https://dav.example.com/remote.php/dav/files/user"/>
              <div class="upl-hint">
                推荐：<a href="https://infini-cloud.net/en/" target="_blank" style="color:#0066cc;text-decoration:none">infini</a>（使用推介码 <strong>HBG6T</strong> 额外获得 20+5G 空间）<br>
                
              </div>
            </div>
            <label for="sync-root">Root Path</label>
            <div class="upl-field">
              <input id="sync-root" type="text" placeholder="/flymd"/>
              <div class="upl-hint">${t('sync.root.hint')}</div>
            </div>
            <label for="sync-user">${t('sync.user')}</label>
            <div class="upl-field"><input id="sync-user" type="text" placeholder="${t('upl.ak.ph')}"/></div>
            <label for="sync-pass">${t('sync.pass')}</label>
            <div class="upl-field"><input id="sync-pass" type="password" placeholder="${t('upl.sk.ph')}"/></div>
          </div>
          <div class="upl-actions">
            <button type="button" id="sync-openlog" class="btn-secondary">${t('sync.openlog')}</button>
            <button type="button" id="sync-test" class="btn-secondary">${t('sync.now')}</button>
            <button type="submit" id="sync-save" class="btn-primary">${t('sync.save')}</button>
          </div>
        </form>
      </div>
    `
    document.body.appendChild(overlay)
  }

  const show = (v: boolean) => {
    if (!overlay) return
    if (v) overlay.classList.remove('hidden')
    else overlay.classList.add('hidden')
  }

  const form = overlay.querySelector('#sync-form') as HTMLFormElement
  const btnClose = overlay.querySelector('#sync-close') as HTMLButtonElement
  const btnSave = overlay.querySelector('#sync-save') as HTMLButtonElement
  const btnTest = overlay.querySelector('#sync-test') as HTMLButtonElement
  const btnOpenLog = overlay.querySelector('#sync-openlog') as HTMLButtonElement
  const elEnabled = overlay.querySelector('#sync-enabled') as HTMLInputElement
  const elOnStartup = overlay.querySelector('#sync-onstartup') as HTMLInputElement
  const elOnShutdown = overlay.querySelector('#sync-onshutdown') as HTMLInputElement
  const elTimeout = overlay.querySelector('#sync-timeout') as HTMLInputElement
  const elConflictStrategy = overlay.querySelector('#sync-conflict-strategy') as HTMLSelectElement
  const elLocalDeleteStrategy = overlay.querySelector('#sync-local-delete-strategy') as HTMLSelectElement
  const elConfirmDeleteRemote = overlay.querySelector('#sync-confirm-delete-remote') as HTMLInputElement
  const elSkipMinutes = overlay.querySelector('#sync-skip-minutes') as HTMLInputElement
  const elBase = overlay.querySelector('#sync-baseurl') as HTMLInputElement
  const elRoot = overlay.querySelector('#sync-root') as HTMLInputElement
  const elUser = overlay.querySelector('#sync-user') as HTMLInputElement
  const elPass = overlay.querySelector('#sync-pass') as HTMLInputElement
  const elAllowHttp = overlay.querySelector('#sync-allow-http') as HTMLInputElement
  const elAllowHttpWarn = overlay.querySelector('.sync-http-warn') as HTMLDivElement | null
  const elEncryptEnabled = overlay.querySelector('#sync-encrypt-enabled') as HTMLInputElement
  const elEncryptKey = overlay.querySelector('#sync-encrypt-key') as HTMLInputElement
  const elEncryptWarn = overlay.querySelector('.sync-encrypt-warn') as HTMLDivElement | null
  const elEncryptSections = overlay.querySelectorAll('.sync-encrypt-only') as NodeListOf<HTMLElement>
  const elShutdownWarn = overlay.querySelector('.sync-shutdown-warn') as HTMLDivElement | null
  const elHttpHostsSections = overlay.querySelectorAll('.sync-http-hosts') as NodeListOf<HTMLElement>
  const elHttpHostsList = overlay.querySelector('#sync-http-hosts-list') as HTMLDivElement | null

  const cfg = await getWebdavSyncConfig()
  elEnabled.checked = !!cfg.enabled
  elOnStartup.checked = !!cfg.onStartup
  elOnShutdown.checked = !!cfg.onShutdown
  elTimeout.value = String(cfg.timeoutMs || 120000)
  elConflictStrategy.value = cfg.conflictStrategy || 'newest'
  elLocalDeleteStrategy.value = cfg.localDeleteStrategy || 'auto'
  elConfirmDeleteRemote.checked = cfg.confirmDeleteRemote !== false
  elSkipMinutes.value = String(cfg.skipRemoteScanMinutes !== undefined ? cfg.skipRemoteScanMinutes : 5)
  elBase.value = cfg.baseUrl || ''
  elRoot.value = cfg.rootPath || '/flymd'
  elUser.value = cfg.username || ''
  elPass.value = cfg.password || ''
  elAllowHttp.checked = cfg.allowHttpInsecure === true
  elEncryptEnabled.checked = !!cfg.encryptEnabled && !!cfg.encryptKey
  elEncryptKey.value = cfg.encryptKey || ''

  const httpHostPlaceholder = t('sync.allowHttp.hostPlaceholder')

  const addHttpHostRow = (value: string) => {
    if (!elHttpHostsList) return
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.gap = '6px'
    row.style.alignItems = 'center'
    row.style.width = '100%'

    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = httpHostPlaceholder
    input.value = value
    input.style.flex = '1'
    input.style.minWidth = '0'
    input.style.width = '100%'
    input.style.padding = '8px'
    input.style.border = '1px solid var(--border-color, #ccc)'
    input.style.borderRadius = '4px'
    input.style.background = 'var(--input-bg, #fff)'
    input.style.color = 'var(--text-color, #333)'
    input.style.fontSize = '14px'
    row.appendChild(input)

    const btnRemove = document.createElement('button')
    btnRemove.type = 'button'
    btnRemove.textContent = '-'
    btnRemove.title = t('sync.allowHttp.removeHost')
    btnRemove.className = 'btn-secondary'
    btnRemove.style.padding = '6px 12px'
    btnRemove.style.flexShrink = '0'
    btnRemove.addEventListener('click', () => {
      row.remove()
      // 确保至少有一行输入框
      ensureHttpHostRowWhenVisible()
    })
    row.appendChild(btnRemove)

    const btnAdd = document.createElement('button')
    btnAdd.type = 'button'
    btnAdd.textContent = '+'
    btnAdd.title = t('sync.allowHttp.addHost')
    btnAdd.className = 'btn-secondary'
    btnAdd.style.padding = '6px 12px'
    btnAdd.style.flexShrink = '0'
    btnAdd.addEventListener('click', () => {
      addHttpHostRow('')
    })
    row.appendChild(btnAdd)

    elHttpHostsList.appendChild(row)
  }

  const setHttpHostRows = (values: string[]) => {
    if (!elHttpHostsList) return
    elHttpHostsList.innerHTML = ''
    for (const v of values) addHttpHostRow(v)
  }

  const ensureHttpHostRowWhenVisible = () => {
    if (!elHttpHostsList) return
    if (elHttpHostsList.querySelectorAll('input').length === 0) {
      addHttpHostRow('')
    }
  }

  const getHttpHostValues = (): string[] => {
    if (!elHttpHostsList) return []
    const out: string[] = []
    elHttpHostsList.querySelectorAll('input').forEach((input) => {
      const val = input.value.trim()
      if (val) out.push(val)
    })
    return out
  }

  setHttpHostRows(Array.isArray(cfg.allowedHttpHosts) ? cfg.allowedHttpHosts : [])

  const refreshAllowHttpWarn = () => {
    if (!elAllowHttpWarn) return
    if (elAllowHttp.checked) elAllowHttpWarn.classList.remove('hidden')
    else elAllowHttpWarn.classList.add('hidden')
  }
  refreshAllowHttpWarn()

  const refreshEncryptVisibility = () => {
    const enabled = elEncryptEnabled.checked
    if (elEncryptWarn) {
      if (enabled) elEncryptWarn.classList.remove('hidden')
      else elEncryptWarn.classList.add('hidden')
    }
    elEncryptSections.forEach(el => {
      if (enabled) el.classList.remove('hidden')
      else el.classList.add('hidden')
    })
  }
  refreshEncryptVisibility()

  const refreshHttpHostsVisibility = () => {
    if (!elHttpHostsSections.length) return
    if (elAllowHttp.checked) {
      elHttpHostsSections.forEach(el => el.classList.remove('hidden'))
      ensureHttpHostRowWhenVisible()
    } else {
      elHttpHostsSections.forEach(el => el.classList.add('hidden'))
    }
  }
  refreshHttpHostsVisibility()
  elAllowHttp.addEventListener('change', () => {
    refreshAllowHttpWarn()
    refreshHttpHostsVisibility()
  })
  elEncryptEnabled.addEventListener('change', refreshEncryptVisibility)

  const refreshShutdownWarn = () => {
    if (!elShutdownWarn) return
    if (elOnShutdown.checked) elShutdownWarn.classList.remove('hidden')
    else elShutdownWarn.classList.add('hidden')
  }
  refreshShutdownWarn()
  elOnShutdown.addEventListener('change', refreshShutdownWarn)

  const onSubmit = async (e: Event) => {
    e.preventDefault()
    try {
      if (elEncryptEnabled.checked) {
        const key = elEncryptKey.value.trim()
        if (!key || key.length < 8) {
          alert(t('sync.encrypt.keyRequired'))
          return
        }
      }
      await setWebdavSyncConfig({
        enabled: elEnabled.checked,
        onStartup: elOnStartup.checked,
        onShutdown: elOnShutdown.checked,
        timeoutMs: Math.max(1000, Number(elTimeout.value) || 120000),
        conflictStrategy: elConflictStrategy.value as 'ask' | 'newest' | 'last-wins',
        localDeleteStrategy: elLocalDeleteStrategy.value as 'ask' | 'auto' | 'keep',
        confirmDeleteRemote: elConfirmDeleteRemote.checked,
        skipRemoteScanMinutes: Math.max(0, Number(elSkipMinutes.value) || 5),
        baseUrl: elBase.value.trim(),
        rootPath: elRoot.value.trim() || '/flymd',
        username: elUser.value,
        password: elPass.value,
        allowHttpInsecure: elAllowHttp.checked,
        allowedHttpHosts: getHttpHostValues(),
        encryptEnabled: elEncryptEnabled.checked,
        encryptKey: elEncryptKey.value.trim(),
      })
      // 反馈
      try { const el = document.getElementById('status'); if (el) { el.textContent = t('sync.saved'); setTimeout(() => { try { el.textContent = '' } catch {} }, 1200) } } catch {}
      show(false)
    } catch (e) {
      alert(t('sync.save.fail', { msg: (e as any)?.message || String(e) }))
    }
  }

  const onCancel = () => show(false)
  const onOverlayClick = (e: MouseEvent) => { if (e.target === overlay) onCancel() }

  form.addEventListener('submit', onSubmit)
  btnTest.onclick = () => { void syncNow('manual') }
  btnOpenLog.onclick = () => { void openSyncLog() }
  btnClose.onclick = onCancel
  overlay.addEventListener('click', onOverlayClick)

  show(true)
}
// 远端目录保障：逐级 MKCOL 创建目录（已存在则忽略）
async function mkcol(baseUrl: string, auth: { username: string; password: string }, remotePath: string): Promise<number> {
  const http = await getHttpClient(); if (!http) return 0
  const url = joinUrl(baseUrl, remotePath)
  const authStr = btoa(`${auth.username}:${auth.password}`)
  const headers: Record<string,string> = { Authorization: `Basic ${authStr}`}
  try {
    let status = 0
    await withHttpRetry('[mkcol] ' + remotePath, async () => {
      const resp = await (http as any).fetch(url, { method: 'MKCOL', headers })
      status = Number((resp as any)?.status || 0)
      // MKCOL 多次调用是幂等的，这里只要能拿到状态码就认为成功一次尝试
      return true as any
    })
    return status
  } catch {
    return 0
  }
}

async function ensureRemoteDir(baseUrl: string, auth: { username: string; password: string }, remoteDir: string): Promise<void> {
  try {
    if (!remoteDir) return
    const parts = remoteDir.replace(/\\/g,'/').replace(/\/+$/,'').split('/').filter(Boolean)
    let cur = ''
    for (const p of parts) { cur += '/' + p; try { await mkcol(baseUrl, auth, cur) } catch {} }
  } catch {}
}

