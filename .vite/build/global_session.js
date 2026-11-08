'use strict'

/**
 * 多账号 Claude Code 会话记录同步
 *
 * 触发方式：
 *   switch account 窗口里注入「同步所有账号 Claude Code 记录」按钮
 *   点击 -> 原生确认框 -> 同步 -> 自动重启
 *
 * 规则：
 *   - 扫描 MagicClaude 下所有账号备份 + 当前 live 数据
 *   - 同一个 local_<cliSessionId>.json 按文件字节大小取最大版本
 *   - 所有账号都写入全集，不跳过记录
 *   - scratch-workspaces 复制到目标账号自己的 scratch 目录
 *   - transcript 缺失时不生成，只写标记
 */

const { app, dialog } = require('electron')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')

const SESSION_DIR = 'claude-code-sessions'
const LOCAL_PREFIX = 'local_'
const JSON_SUFFIX = '.json'
const HASH_PREFIX = '#session-sync-'
const BUTTON_ID = 'session-sync-btn'
const MANIFEST_NAME = 'session-sync-manifest.json'
const REPORT_NAME = 'session-sync-report.json'
const LOCK_NAME = 'session-sync.lock'
const CONFIG_NAME = 'session-sync.json'
const IMPORTER_PROJECT = 'session-sync-imported'
const SCRATCH_MARKER = '.session-sync-copy.json'
const CLONE_FLAGS = fs.constants.COPYFILE_FICLONE || 0
const TARGET_CONCURRENCY = 3
const COPY_CONCURRENCY = 8

// 备份目录里不需要进入的重目录，避免扫描整个 scratch/cache 树
const PRUNE_DIRS = new Set([
  'scratch-workspaces',
  'Cache',
  'Code Cache',
  'GPUCache',
  'GraphiteDawnCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Crashpad',
  'IndexedDB',
  'Local Storage',
  'Session Storage',
  'blob_storage',
  'Network',
  'Service Worker',
  'node_modules',
  '.git',
  'claude-code',
  'vm_bundles',
  'logs',
  'Logs',
  'file-history',
  'shell-snapshots',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/

let installed = false
let syncInProgress = false

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function magicDir() {
  return path.join(app.getPath('appData'), 'MagicClaude')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

function isInside(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string') return false
  const rel = path.relative(parent, child)
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

// 小并发池：用于目录复制和目标账号并行
function mapLimit(items, limit, fn) {
  return new Promise((resolve, reject) => {
    const list = [...items]
    if (list.length === 0) {
      resolve([])
      return
    }
    const results = new Array(list.length)
    let next = 0
    let active = 0
    let done = 0
    const pump = () => {
      if (done === list.length) {
        resolve(results)
        return
      }
      while (active < limit && next < list.length) {
        const index = next++
        active++
        Promise.resolve()
          .then(() => fn(list[index], index))
          .then(
            (value) => {
              results[index] = value
              active--
              done++
              pump()
            },
            (err) => reject(err)
          )
      }
    }
    pump()
  })
}

function claudeProjectsRoot() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(base, 'projects')
}

function loadConfig() {
  const raw = readJson(path.join(magicDir(), CONFIG_NAME), {}) || {}
  return {
    createMissingCwd: raw.createMissingCwd !== false,
    cwdFallback: typeof raw.cwdFallback === 'string' && raw.cwdFallback ? raw.cwdFallback : null,
    sanitizePermissions: raw.sanitizePermissions === true,
    scanDirs: Array.isArray(raw.scanDirs)
      ? raw.scanDirs.filter((p) => typeof p === 'string' && p)
      : [],
  }
}

function readProfiles() {
  const dir = magicDir()
  const profiles = readJson(path.join(dir, 'profiles.json'), {}) || {}
  const current = readJson(path.join(dir, 'profile.json'), null)
  if (current && current.uuid) {
    profiles[current.uuid] = {
      ...(profiles[current.uuid] || {}),
      ...current,
    }
  }
  return { profiles, current }
}

// ---------------------------------------------------------------------------
// 账号目录发现
// ---------------------------------------------------------------------------

// 备份里的 userData 根在账号被还原后会变成哪个 live 路径
function liveRootForBackup(backupRoot, uuid) {
  try {
    const rel = path.relative(path.join(magicDir(), uuid), backupRoot)
    if (!rel || rel.startsWith('..')) return backupRoot
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), rel)
    }
    if (process.platform === 'win32') {
      const parts = rel.split(path.sep)
      const base =
        parts[0] === 'LocalAppData'
          ? process.env.LOCALAPPDATA
          : process.env.APPDATA
      if (base) return path.join(base, ...parts.slice(1))
    }
  } catch {}
  return backupRoot
}

function knownUserDataRoots(uuid) {
  const base = path.join(magicDir(), uuid)
  if (process.platform === 'darwin') {
    return [
      path.join(base, 'Library/Application Support/Claude'),
      path.join(base, 'Library/Application Support/Claude-3p'),
    ]
  }
  if (process.platform === 'win32') {
    return [
      path.join(base, 'AppData/Claude'),
      path.join(base, 'AppData/Claude-3p'),
      path.join(base, 'LocalAppData/Claude'),
      path.join(base, 'LocalAppData/Claude-3p'),
    ]
  }
  return [
    path.join(base, 'Claude'),
    path.join(base, 'Claude-3p'),
  ]
}

// 在备份根目录里找包含 claude-code-sessions 的 userData 根。
// 只作为已知路径都找不到时的兜底，并且跳过 scratch/cache 等重目录。
function findSessionRoots(root) {
  const found = new Set()
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()
    if (depth > 6) continue
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (PRUNE_DIRS.has(entry.name)) continue
      const child = path.join(dir, entry.name)
      if (entry.name === SESSION_DIR) {
        found.add(dir)
        continue
      }
      queue.push({ dir: child, depth: depth + 1 })
    }
  }
  return [...found]
}

function discoverStores(profiles, current) {
  const stores = []
  const seen = new Set()

  const add = (store) => {
    if (!store || !store.sessionsRoot || seen.has(store.sessionsRoot)) return
    seen.add(store.sessionsRoot)
    stores.push(store)
  }

  const liveRoot = app.getPath('userData')
  add({
    id: 'live',
    kind: 'live',
    userDataRoot: liveRoot,
    liveUserDataRoot: liveRoot,
    sessionsRoot: path.join(liveRoot, SESSION_DIR),
    targetUuid: current && current.uuid ? current.uuid : null,
    targetOrg: current && current.organization_id ? current.organization_id : null,
  })

  const magic = magicDir()
  let entries = []
  try {
    entries = fs.readdirSync(magic, { withFileTypes: true })
  } catch {
    return stores
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue
    const uuid = entry.name
    // 当前账号的数据在 live 目录里；它的 MagicClaude/<uuid> 目录是下次切号备份目标，
    // 不能提前写入，否则 saveCurrentAccount 会认为备份目录非空而失败。
    if (current && current.uuid === uuid) continue
    const backupRoot = path.join(magic, uuid)
    const profile = profiles[uuid] || {}
    const known = knownUserDataRoots(uuid)
    // 绝大多数情况直接命中已知目录，不再遍历整个备份。
    let roots = known.filter((p) => fs.existsSync(path.join(p, SESSION_DIR)))
    if (roots.length === 0) {
      roots = known.filter((p) => fs.existsSync(p))
    }
    if (roots.length === 0) {
      roots = findSessionRoots(backupRoot)
    }
    for (const root of [...new Set(roots)]) {
      add({
        id: uuid,
        kind: 'backup',
        userDataRoot: root,
        liveUserDataRoot: liveRootForBackup(root, uuid),
        sessionsRoot: path.join(root, SESSION_DIR),
        targetUuid: uuid,
        targetOrg: profile.organization_id || null,
      })
    }
  }

  return stores
}

function listAccounts(sessionsRoot) {
  let entries
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const accountDir = path.join(sessionsRoot, entry.name)
    let orgs = []
    try {
      orgs = fs
        .readdirSync(accountDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      orgs = []
    }
    out.push({ uuid: entry.name, orgs })
  }
  return out
}

function resolveTarget(store) {
  const accounts = listAccounts(store.sessionsRoot)
  let uuid = store.targetUuid
  let org = store.targetOrg

  if (!uuid && accounts.length === 1) uuid = accounts[0].uuid
  if (!org && uuid) {
    const account = accounts.find((a) => a.uuid === uuid)
    if (account && account.orgs.length > 0) org = account.orgs[0]
  }
  if (!uuid || !org) return null

  return {
    store,
    uuid,
    org,
    dir: path.join(store.sessionsRoot, uuid, org),
  }
}

function listSessionFiles(store) {
  const out = []
  for (const account of listAccounts(store.sessionsRoot)) {
    for (const org of account.orgs) {
      const dir = path.join(store.sessionsRoot, account.uuid, org)
      let files = []
      try {
        files = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const name of files) {
        if (!name.startsWith(LOCAL_PREFIX) || !name.endsWith(JSON_SUFFIX)) continue
        const file = path.join(dir, name)
        let stat
        try {
          stat = fs.statSync(file)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        out.push({
          store,
          file,
          accountId: account.uuid,
          orgId: org,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          id: name.slice(LOCAL_PREFIX.length, -JSON_SUFFIX.length),
        })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// transcript 索引
// ---------------------------------------------------------------------------

function buildTranscriptIndex(config) {
  const index = new Map()
  const roots = new Set([claudeProjectsRoot()])

  for (const dir of config.scanDirs) {
    roots.add(path.join(dir, 'projects'))
    roots.add(dir)
  }

  for (const root of roots) {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectDir = path.join(root, entry.name)
      let files
      try {
        files = fs.readdirSync(projectDir)
      } catch {
        continue
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue
        const id = name.slice(0, -'.jsonl'.length)
        if (!SAFE_ID_RE.test(id)) continue
        const file = path.join(projectDir, name)
        let stat
        try {
          stat = fs.statSync(file)
        } catch {
          continue
        }
        const current = index.get(id)
        if (!current || stat.size > current.size || (stat.size === current.size && stat.mtimeMs > current.mtimeMs)) {
          index.set(id, { path: file, size: stat.size, mtimeMs: stat.mtimeMs })
        }
      }
    }
  }

  return index
}

async function ensureTranscriptInProjects(source, id, ctx) {
  if (typeof source !== 'string' || !source) return
  const projects = claudeProjectsRoot()
  if (isInside(source, projects)) return

  const dir = path.join(projects, IMPORTER_PROJECT)
  const dest = path.join(dir, `${id}.jsonl`)
  let destStat = null
  let sourceStat = null
  try {
    destStat = fs.statSync(dest)
  } catch {}
  try {
    sourceStat = fs.statSync(source)
  } catch {
    return
  }
  if (destStat && destStat.size >= sourceStat.size) return

  fs.mkdirSync(dir, { recursive: true })
  try {
    fs.linkSync(source, dest)
  } catch {
    try {
      await fsp.copyFile(source, dest)
    } catch (err) {
      ctx.stats.errors.push(`复制 transcript 失败 ${source}: ${err.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 记录同步
// ---------------------------------------------------------------------------

function buildCatalog(stores, stats) {
  const catalog = new Map()

  for (const store of stores) {
    for (const file of listSessionFiles(store)) {
      stats.sources++
      if (!SAFE_ID_RE.test(file.id)) {
        stats.errors.push(`非法 session id，无法写入目标文件名: ${file.file}`)
        continue
      }

      let record = null
      try {
        record = JSON.parse(fs.readFileSync(file.file, 'utf8'))
      } catch (err) {
        stats.errors.push(`JSON 解析失败，将按原始字节复制: ${file.file} (${err.message})`)
      }

      const lastActivity =
        record && Number.isFinite(Number(record.lastActivityAt))
          ? Number(record.lastActivityAt)
          : file.mtimeMs

      // 文件名里的 id 是 Desktop session id；
      // record.cliSessionId 才是 transcript 的 id，两者可能不同。
      const cliSessionId =
        record && typeof record.cliSessionId === 'string' && SAFE_ID_RE.test(record.cliSessionId)
          ? record.cliSessionId
          : file.id

      const entry = { ...file, record, lastActivity, cliSessionId }
      const current = catalog.get(file.id)
      if (!current || isBetterVersion(entry, current)) {
        catalog.set(file.id, entry)
      }
    }
  }

  return catalog
}

function isBetterVersion(a, b) {
  if (a.size !== b.size) return a.size > b.size
  if (a.lastActivity !== b.lastActivity) return a.lastActivity > b.lastActivity
  return a.mtimeMs > b.mtimeMs
}

// 从路径中拆出 scratch-workspaces 后面的部分
function scratchParts(value) {
  if (typeof value !== 'string' || !value) return null
  const normalized = value.replace(/\\/g, '/')
  const marker = '/scratch-workspaces/'
  const idx = normalized.indexOf(marker)
  if (idx === -1) return null
  const rest = normalized.slice(idx + marker.length)
  const parts = rest.split('/').filter(Boolean)
  if (parts.length < 2) return null
  return parts
}

function readScratchMarker(dest) {
  return readJson(path.join(dest, SCRATCH_MARKER), null)
}

function writeScratchMarker(dest, marker) {
  try {
    fs.writeFileSync(path.join(dest, SCRATCH_MARKER), JSON.stringify(marker))
  } catch {}
}

function sameSignature(a, b) {
  if (!a || !b) return false
  return (
    a.count === b.count &&
    a.dirs === b.dirs &&
    a.size === b.size &&
    Math.abs(Number(a.maxMtimeMs) - Number(b.maxMtimeMs)) < 1
  )
}

async function copyFileFast(source, dest) {
  try {
    if (CLONE_FLAGS) {
      await fsp.copyFile(source, dest, CLONE_FLAGS)
    } else {
      await fsp.copyFile(source, dest)
    }
  } catch {
    // APFS 不支持 clone、跨盘或目标已存在等情况下退回普通复制
    await fsp.copyFile(source, dest)
  }
}

// 递归复制，同时统计签名。APFS 上用 COPYFILE_FICLONE 做 CoW clone，
// 大 scratch 目录通常只需要元数据时间。
async function copyDirFast(sourceDir, destDir, state) {
  state.dirs = (state.dirs || 0) + 1
  let dirStat = null
  try {
    dirStat = await fsp.stat(sourceDir)
  } catch {}
  await fsp.mkdir(destDir, { recursive: true })
  if (dirStat) await fsp.chmod(destDir, dirStat.mode).catch(() => {})
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true })
  await mapLimit(entries, COPY_CONCURRENCY, async (entry) => {
    if (entry.name === SCRATCH_MARKER) return
    const source = path.join(sourceDir, entry.name)
    const dest = path.join(destDir, entry.name)

    if (entry.isDirectory()) {
      await copyDirFast(source, dest, state)
      return
    }

    if (entry.isSymbolicLink()) {
      try {
        const stat = await fsp.lstat(source)
        state.count++
        state.size += stat.size
        if (stat.mtimeMs > state.maxMtimeMs) state.maxMtimeMs = stat.mtimeMs
        const target = await fsp.readlink(source)
        await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
        await fsp.symlink(target, dest)
      } catch {}
      return
    }

    if (!entry.isFile()) return

    let stat
    try {
      stat = await fsp.lstat(source)
    } catch {
      return
    }
    state.count++
    state.size += stat.size
    if (stat.mtimeMs > state.maxMtimeMs) state.maxMtimeMs = stat.mtimeMs
    try {
      await copyFileFast(source, dest)
      await fsp.chmod(dest, stat.mode).catch(() => {})
    } catch (err) {
      throw new Error(`复制文件失败 ${source} -> ${dest}: ${err.message}`)
    }
  })
}

// 只读元数据签名：文件数 + 总大小 + 最大 mtime。比整个目录复制便宜得多。
async function directorySignature(root) {
  const state = { count: 0, dirs: 0, size: 0, maxMtimeMs: 0 }
  async function walk(dir) {
    state.dirs++
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await mapLimit(entries, COPY_CONCURRENCY, async (entry) => {
      if (entry.name === SCRATCH_MARKER) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        return
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) return
      let stat
      try {
        stat = await fsp.lstat(full)
      } catch {
        return
      }
      state.count++
      state.size += stat.size
      if (stat.mtimeMs > state.maxMtimeMs) state.maxMtimeMs = stat.mtimeMs
    })
  }
  await walk(root)
  return state
}

async function ensureScratchCopy(source, dest, ctx) {
  if (source === dest) return
  const key = `${source}\n${dest}`
  const existing = ctx.scratchCopies.get(key)
  if (existing) return existing

  const job = (async () => {
    let stat
    try {
      stat = await fsp.stat(source)
      if (!stat.isDirectory()) return
    } catch {
      // 源 scratch 已经不存在：创建目标空目录，保证会话能定位到 cwd
      try {
        fs.mkdirSync(dest, { recursive: true })
        ctx.stats.scratchMissing++
      } catch (err) {
        ctx.stats.errors.push(`创建 scratch 目录失败 ${dest}: ${err.message}`)
      }
      return
    }

    try {
      const marker = readScratchMarker(dest)
      let signature = ctx.sourceSignatures.get(source)

      // 只有目标已有 marker 时才需要计算源签名；首次复制直接把
      // copyDirFast 统计出来的 state 当作签名，避免多走一遍目录。
      if (marker && marker.source === source && !signature) {
        signature = await directorySignature(source)
        ctx.sourceSignatures.set(source, signature)
      }
      if (
        marker &&
        marker.source === source &&
        signature &&
        sameSignature(marker.signature, signature) &&
        fs.existsSync(dest)
      ) {
        ctx.stats.scratchSkipped++
        return
      }

      const state = { count: 0, dirs: 0, size: 0, maxMtimeMs: 0 }
      await copyDirFast(source, dest, state)
      if (!ctx.sourceSignatures.has(source)) {
        ctx.sourceSignatures.set(source, state)
      }
      writeScratchMarker(dest, {
        source,
        signature: state,
        at: Date.now(),
      })
      ctx.stats.scratchCopied++
    } catch (err) {
      ctx.stats.errors.push(`复制 scratch 失败 ${source} -> ${dest}: ${err.message}`)
      try {
        fs.mkdirSync(dest, { recursive: true })
      } catch {}
    }
  })()

  ctx.scratchCopies.set(key, job)
  return job
}

async function resolveOnePath(value, target, ctx, winner) {
  if (typeof value !== 'string' || !value) {
    return { value, changed: false }
  }

  const parts = scratchParts(value)
  if (parts) {
    // 文件写到当前 store 里（备份账号就写进备份），
    // 但记录里的 cwd 必须写“该账号被还原后的 live 路径”，
    // 否则下次切到这个账号时路径已经不存在。
    const relativeParts = [target.uuid, target.org, ...parts.slice(2)]
    const diskDest = path.join(
      target.store.userDataRoot,
      'scratch-workspaces',
      ...relativeParts
    )
    const liveDest = path.join(
      target.store.liveUserDataRoot || target.store.userDataRoot,
      'scratch-workspaces',
      ...relativeParts
    )

    // 记录里的 cwd 通常是该账号当时 live 的路径；账号被切走后，
    // 实际目录在 winner.store.userDataRoot（备份根）下，需要从备份里找。
    const candidates = [
      value,
      path.join(winner.store.userDataRoot, 'scratch-workspaces', ...parts),
    ]
    const source = candidates.find((p) => fs.existsSync(p)) || value
    await ensureScratchCopy(source, diskDest, ctx)
    return { value: liveDest, changed: liveDest !== value }
  }

  if (!fs.existsSync(value)) {
    if (ctx.config.createMissingCwd) {
      try {
        fs.mkdirSync(value, { recursive: true })
        ctx.stats.cwdCreated++
      } catch (err) {
        ctx.stats.errors.push(`创建 cwd 失败 ${value}: ${err.message}`)
      }
      return { value, changed: false }
    }
    const fallback = ctx.config.cwdFallback || os.homedir()
    ctx.stats.cwdFallback++
    return { value: fallback, changed: fallback !== value }
  }

  return { value, changed: false }
}

async function adaptRecord(record, winner, target, ctx) {
  let changed = false
  const set = (key, value) => {
    if (record[key] !== value) {
      record[key] = value
      changed = true
    }
  }

  set('sessionId', `${LOCAL_PREFIX}${winner.id}`)
  set('cliSessionId', winner.cliSessionId)

  if (typeof record.cwd !== 'string' || !record.cwd) {
    set('cwd', os.homedir())
  }
  const cwd = await resolveOnePath(record.cwd, target, ctx, winner)
  if (cwd.changed) set('cwd', cwd.value)

  if (typeof record.originCwd === 'string' && record.originCwd) {
    const origin = await resolveOnePath(record.originCwd, target, ctx, winner)
    if (origin.changed) set('originCwd', origin.value)
  } else if (record.originCwd !== record.cwd) {
    set('originCwd', record.cwd)
  }

  if (typeof record.worktreePath === 'string' && record.worktreePath) {
    const worktree = await resolveOnePath(record.worktreePath, target, ctx, winner)
    if (worktree.changed) set('worktreePath', worktree.value)
  }

  if (record.homeTenancy && typeof record.homeTenancy === 'object') {
    const next = { accountId: target.uuid, orgId: target.org }
    if (
      record.homeTenancy.accountId !== next.accountId ||
      record.homeTenancy.orgId !== next.orgId
    ) {
      set('homeTenancy', next)
    }
  }

  // transcript：缺失时只标记，不生成
  const transcript = ctx.transcriptIndex.get(winner.cliSessionId)
  if (transcript) {
    const transcriptKey = winner.cliSessionId
    if (!ctx.transcriptEnsured.has(transcriptKey)) {
      ctx.transcriptEnsured.set(
        transcriptKey,
        ensureTranscriptInProjects(transcript.path, transcriptKey, ctx).catch(() => {})
      )
    }
    await ctx.transcriptEnsured.get(transcriptKey)
    if (record.transcriptUnavailable === true) {
      delete record.transcriptUnavailable
      changed = true
    }
  } else {
    if (record.transcriptUnavailable !== true) {
      record.transcriptUnavailable = true
      changed = true
    }
    ctx.stats.missingTranscript++
  }

  if (!Number.isFinite(Number(record.createdAt))) {
    const fallback = Number(winner.record && winner.record.createdAt) || winner.mtimeMs
    set('createdAt', fallback)
  }
  if (!Number.isFinite(Number(record.lastActivityAt))) {
    set('lastActivityAt', winner.lastActivity)
  }

  if (ctx.config.sanitizePermissions) {
    if (record.permissionMode === 'bypassPermissions') {
      set('permissionMode', 'acceptEdits')
    }
    if (Array.isArray(record.sessionPermissionUpdates) && record.sessionPermissionUpdates.length > 0) {
      record.sessionPermissionUpdates = []
      changed = true
    }
    if (Array.isArray(record.alwaysAllowedReasons) && record.alwaysAllowedReasons.length > 0) {
      record.alwaysAllowedReasons = []
      changed = true
    }
    if (record.isArchived) set('isArchived', false)
  }

  return changed
}

async function syncOne(id, winner, target, ctx) {
  const targetFile = path.join(target.dir, `${LOCAL_PREFIX}${id}${JSON_SUFFIX}`)
  let existing = null
  try {
    existing = fs.statSync(targetFile)
  } catch {}

  const manifestKey = target.dir
  const previous = ctx.manifest.targets[manifestKey] && ctx.manifest.targets[manifestKey][id]
  if (
    existing &&
    previous &&
    previous.sourceSize >= winner.size &&
    previous.targetSize === existing.size &&
    previous.targetMtimeMs === existing.mtimeMs
  ) {
    ctx.stats.alreadySynced++
    return
  }

  // 目标已经是最大版本：保留
  if (existing && existing.size >= winner.size) {
    ctx.stats.keptLarger++
    return
  }

  const record = winner.record ? JSON.parse(JSON.stringify(winner.record)) : null
  let changed = false
  if (record) {
    changed = await adaptRecord(record, winner, target, ctx)
  } else {
    ctx.stats.unparsedRawCopied++
  }

  let data
  if (record && (changed || ctx.config.sanitizePermissions)) {
    let buf = Buffer.from(JSON.stringify(record))
    // 重写路径后 JSON 可能变短；补空格到源文件大小，
    // 避免下一轮又因为目标文件更小而被反复覆盖。
    if (buf.length < winner.size) {
      buf = Buffer.concat([buf, Buffer.alloc(winner.size - buf.length, 0x20)])
    }
    data = buf
  } else if (winner.rawBytes) {
    data = winner.rawBytes
  } else {
    data = fs.readFileSync(winner.file)
    winner.rawBytes = data
  }

  if (!ctx.madeDirs.has(target.dir)) {
    fs.mkdirSync(target.dir, { recursive: true })
    ctx.madeDirs.add(target.dir)
  }

  if (existing) {
    try {
      fs.copyFileSync(targetFile, `${targetFile}.bak`)
    } catch {}
  }

  const tmp = `${targetFile}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, targetFile)

  const written = fs.statSync(targetFile)
  ctx.manifest.targets[manifestKey] = ctx.manifest.targets[manifestKey] || {}
  ctx.manifest.targets[manifestKey][id] = {
    sourceSize: winner.size,
    sourceMtimeMs: winner.mtimeMs,
    sourcePath: winner.file,
    sourceAccountId: winner.accountId,
    sourceOrgId: winner.orgId,
    targetSize: written.size,
    targetMtimeMs: written.mtimeMs,
    writtenAt: Date.now(),
  }
  ctx.stats.written++
}

// ---------------------------------------------------------------------------
// manifest / lock / report
// ---------------------------------------------------------------------------

function readManifest() {
  const value = readJson(path.join(magicDir(), MANIFEST_NAME), null)
  if (!value || typeof value !== 'object') return { version: 1, targets: {} }
  if (!value.targets || typeof value.targets !== 'object') value.targets = {}
  return value
}

function writeManifest(manifest) {
  writeJsonAtomic(path.join(magicDir(), MANIFEST_NAME), manifest)
}

function acquireLock() {
  const dir = magicDir()
  fs.mkdirSync(dir, { recursive: true })
  const lockPath = path.join(dir, LOCK_NAME)

  const create = () => {
    const fd = fs.openSync(lockPath, 'wx')
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    } finally {
      fs.closeSync(fd)
    }
  }

  try {
    create()
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    let pid = 0
    try {
      pid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid
    } catch {}
    let alive = false
    if (pid) {
      try {
        process.kill(pid, 0)
        alive = true
      } catch (e) {
        alive = e.code === 'EPERM'
      }
    }
    if (alive) {
      throw new Error('已有同步任务在运行，请等待完成后再试。')
    }
    fs.rmSync(lockPath, { force: true })
    create()
  }

  return () => {
    try {
      fs.rmSync(lockPath, { force: true })
    } catch {}
  }
}

function writeReport(stats, startedAt, stores, catalog) {
  const report = {
    at: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    platform: process.platform,
    stores: stores.map((s) => ({
      kind: s.kind,
      id: s.id,
      userDataRoot: s.userDataRoot,
      sessionsRoot: s.sessionsRoot,
    })),
    uniqueSessions: catalog.size,
    ...stats,
    errors: stats.errors.slice(0, 200),
  }
  writeJsonAtomic(path.join(magicDir(), REPORT_NAME), report)
  return report
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function runSync(options = {}) {
  const release = acquireLock()
  const startedAt = Date.now()
  const config = loadConfig()
  const stats = {
    sources: 0,
    targets: 0,
    written: 0,
    keptLarger: 0,
    alreadySynced: 0,
    scratchCopied: 0,
    scratchSkipped: 0,
    scratchMissing: 0,
    cwdCreated: 0,
    cwdFallback: 0,
    missingTranscript: 0,
    unparsedRawCopied: 0,
    errors: [],
  }

  try {
    const { profiles, current } = readProfiles()
    const stores = discoverStores(profiles, current)
    const transcriptIndex = buildTranscriptIndex(config)
    const manifest = readManifest()
    const catalog = buildCatalog(stores, stats)

    const targets = []
    for (const store of stores) {
      const target = resolveTarget(store)
      if (target) {
        targets.push(target)
      } else {
        stats.errors.push(`无法确定目标账号/组织: ${store.sessionsRoot}`)
      }
    }
    stats.targets = targets.length

    const ctx = {
      config,
      transcriptIndex,
      manifest,
      stats,
      scratchCopies: new Map(),
      sourceSignatures: new Map(),
      transcriptEnsured: new Map(),
      madeDirs: new Set(),
    }

    const total = Math.max(1, targets.length * catalog.size)
    let done = 0

    await mapLimit(targets, TARGET_CONCURRENCY, async (target) => {
      for (const [id, winner] of catalog) {
        try {
          await syncOne(id, winner, target, ctx)
        } catch (err) {
          stats.errors.push(`同步失败 ${id} -> ${target.dir}: ${err.message}`)
        }
        done++
        if (done % 10 === 0 || done === total) {
          if (typeof options.onProgress === 'function') {
            try {
              options.onProgress({
                done,
                total,
                target: target.uuid,
              })
            } catch {}
          }
        }
      }
    })

    writeManifest(manifest)
    const report = writeReport(stats, startedAt, stores, catalog)
    console.log(
      `[session-sync] 完成: stores=${stores.length} targets=${targets.length} unique=${catalog.size} ` +
        `written=${stats.written} kept=${stats.keptLarger} already=${stats.alreadySynced} ` +
        `scratchCopied=${stats.scratchCopied} scratchSkipped=${stats.scratchSkipped} missingTranscript=${stats.missingTranscript} errors=${stats.errors.length}`
    )
    return report
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------------
// switch account 页面按钮
// ---------------------------------------------------------------------------

function isSwitchWindow(win) {
  try {
    if (!win || win.isDestroyed()) return false
    const url = win.webContents.getURL() || ''
    return url.includes('switch_account.html') || win.getTitle() === 'Switch Account'
  } catch {
    return false
  }
}

async function setButtonState(win, busy, text) {
  if (!win || win.isDestroyed()) return
  const script = `(() => {
    const button = document.getElementById(${JSON.stringify(BUTTON_ID)});
    if (!button) return;
    button.disabled = ${busy ? 'true' : 'false'};
    button.textContent = ${JSON.stringify(text)};
  })()`
  try {
    await win.webContents.executeJavaScript(script, true)
  } catch {}
}

async function injectSyncButton(win) {
  if (!isSwitchWindow(win)) return
  const script = `(() => {
    if (document.getElementById(${JSON.stringify(BUTTON_ID)})) return true;
    const footer = document.querySelector('footer');
    if (!footer) return false;
    const button = document.createElement('button');
    button.id = ${JSON.stringify(BUTTON_ID)};
    button.type = 'button';
    button.className = 'btn';
    button.textContent = '同步所有账号 Claude Code 记录';
    button.style.marginRight = 'auto';
    button.addEventListener('click', () => {
      if (button.disabled) return;
      location.hash = 'session-sync-' + Date.now();
    });
    footer.insertBefore(button, footer.firstChild);
    return true;
  })()`
  try {
    await win.webContents.executeJavaScript(script, true)
  } catch (err) {
    console.error('[session-sync] 注入按钮失败:', err)
  }
}

function showMessage(win, options) {
  if (win && !win.isDestroyed()) {
    return dialog.showMessageBox(win, options)
  }
  return dialog.showMessageBox(options)
}

function formatReport(report) {
  const lines = [
    `已写入 ${report.written} 个会话记录`,
    `保留目标较大文件 ${report.keptLarger} 个`,
    `已同步过 ${report.alreadySynced} 个`,
    `目标账号 ${report.targets} 个`,
    `复制 scratch 目录 ${report.scratchCopied} 个`,
    `transcript 缺失 ${report.missingTranscript} 个`,
  ]
  if (report.errors && report.errors.length > 0) {
    lines.push(`警告 ${report.errors.length} 条，详见 session-sync-report.json`)
  }
  return lines.join('\n')
}

async function handleSyncClick(win) {
  if (syncInProgress) {
    await showMessage(win, {
      type: 'info',
      message: '同步正在进行',
      detail: '请等待当前同步任务完成。',
      buttons: ['OK'],
    })
    return
  }

  syncInProgress = true
  let restarting = false

  try {
    const answer = await showMessage(win, {
      type: 'question',
      message: '确认同步所有账号的 Claude Code 记录吗？',
      detail:
        '完成后应用会自动重启。',
      buttons: ['取消', '开始同步'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    })
    if (answer.response !== 1) return

    await setButtonState(win, true, '正在同步，请稍候…')

    const report = await runSync({
      onProgress: ({ done, total }) => {
        if (done % 50 === 0 || done === total) {
          setButtonState(win, true, `正在同步 ${done}/${total}…`).catch(() => {})
        }
      },
    })

    await showMessage(win, {
      type: 'info',
      message: '同步完成',
      detail: `应用将自动重启以加载新的会话记录。`,
      buttons: ['重启'],
    })

    restarting = true
    app.relaunch()
    app.exit(0)
  } catch (err) {
    console.error('[session-sync] 同步失败:', err)
    await showMessage(win, {
      type: 'error',
      message: '同步失败',
      detail: String((err && err.message) || err),
      buttons: ['OK'],
    })
  } finally {
    syncInProgress = false
    if (!restarting) {
      await setButtonState(win, false, '同步所有账号 Claude Code 记录')
    }
  }
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

function install() {
  if (installed) return
  installed = true

  app.on('browser-window-created', (_event, win) => {
    try {
      win.webContents.on('did-finish-load', () => {
        injectSyncButton(win).catch(() => {})
      })
      win.webContents.on('did-navigate-in-page', (_event, url) => {
        if (!isSwitchWindow(win)) return
        if (!url || !url.includes(HASH_PREFIX)) return
        handleSyncClick(win).catch((err) => {
          console.error('[session-sync] 处理点击失败:', err)
        })
      })
    } catch (err) {
      console.error('[session-sync] 监听窗口失败:', err)
    }
  })
}

module.exports = {
  install,
  runSync,
}
