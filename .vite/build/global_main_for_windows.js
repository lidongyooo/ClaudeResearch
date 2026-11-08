// Windows 账号切换的备份与还原：备份与还原 Claude 相关的顶层目录
// 数据位于真实的 %APPDATA% 与 %LOCALAPPDATA% 下，两边都纳入备份
// 切换与添加账号时，global_main.js 只把动作写入 MagicClaude/custom_env.json 的 accountAction 字段并重启：
// 旧进程仍持有 Cookies、LevelDB 等文件，在它退出之前无法复制，所以备份与还原都在下次启动时由 applyPendingAction 完成
// 由 global_main.js 在 win32 平台上引入
// 不处理 %USERPROFILE%\.claude.json 与 .claude\.credentials.json（按需求不随账号切换）
// safeStorage 的密钥在 Local State（DPAPI 包装）中，随 Roaming 目录一起复制，无需单独备份钥匙串
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

// 账号数据目录：1p 为 Claude（数据目录为 Claude-Data），3p 为 Claude-3p；两者都要随账号隔离
const ACCOUNT_DIRS = ['Claude-Data', 'Claude', 'Claude-3p']
// 备份内的前缀，用来区分两个根：
//   AppData/...         真实 %APPDATA%
//   LocalAppData/...    真实 %LOCALAPPDATA%
const ROOT_PREFIXES = {
    AppData: () => process.env.APPDATA,
    LocalAppData: () => process.env.LOCALAPPDATA,
}

function lexists(p) {
    try {
        fs.lstatSync(p)
        return true
    } catch (e) {
        return false
    }
}

// 账号数据的全部顶层目录，返回备份内的相对路径（如 AppData/Claude、LocalAppData/Claude-Data）
function accountRels() {
    return ['AppData', 'LocalAppData'].flatMap((root) => ACCOUNT_DIRS.map((app) => path.join(root, app)))
}

// 备份相对路径在当前机器上的实际位置，根目录不可用时返回 null
function liveDir(rel) {
    const [root, ...rest] = rel.split(path.sep)
    const base = ROOT_PREFIXES[root]()
    return base ? path.join(base, ...rest) : null
}

// 当前机器上实际存在的账号顶层目录，不存在的跳过
function liveRels() {
    return accountRels().filter((rel) => {
        const dir = liveDir(rel)
        return dir !== null && lexists(dir)
    })
}

// 目标账号数据是否完整（至少存在一个待还原的顶层目录）
function isAccountComplete(targetDir) {
    return accountRels().some((rel) => lexists(path.join(targetDir, rel)))
}

// 同步等待（启动钩子是同步执行的，窗口和数据库还没有打开）
const sleepCell = new Int32Array(new SharedArrayBuffer(4))
const BUSY_CODES = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']
const BUSY_TIMEOUT_MS = 30000

// 文件仍被占用（例如上一个实例还没退出）时每 500ms 重试，最多 30 秒；超时后抛出错误
function retryBusy(fn) {
    const deadline = Date.now() + BUSY_TIMEOUT_MS
    for (;;) {
        try {
            return fn()
        } catch (e) {
            if (!BUSY_CODES.includes(e.code) || Date.now() > deadline) throw e
            Atomics.wait(sleepCell, 0, 0, 500)
        }
    }
}

// 移动目录：同一磁盘直接改名，最快；跨磁盘（EXDEV）时回退为复制后删除
// EBUSY 等在 retryBusy 中已重试 30 秒，仍失败才回退，所以不会在文件被占用时误走复制分支
function moveDir(from, to) {
    console.log('[account-restore] moveDir', from, '->', to)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    try {
        retryBusy(() => fs.renameSync(from, to))
    } catch (e) {
        console.log('[account-restore] rename failed', e.code, e.message)
        if (e.code !== 'EXDEV') throw e
        console.log('[account-restore] fallback copy+delete')
        retryBusy(() => fs.cpSync(from, to, { recursive: true, force: true }))
        retryBusy(() => fs.rmSync(from, { recursive: true, force: true }))
        console.log('[account-restore] fallback done', from)
    }
}

// 读取 profile.json 中的当前账号 uuid，没有则返回 null
function readCurrentUuid(cacheDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(cacheDir, 'profile.json'), 'utf8')).uuid || null
    } catch (e) {
        return null
    }
}

// 构造并写入兜底 profile：profile.json 整体覆盖，profiles.json 中新增该 uuid，其他账号保留
// profile.json 缺失、无法解析或没有 uuid 时使用，保证账号数据仍然可以备份
function writeFallbackProfile(cacheDir) {
    const fallback = {
        'uuid': crypto.randomUUID(),
        'email_address': 'xxxxxx@gmail.com',
        'full_name': 'unknown',
        'organization_id': crypto.randomUUID(),
        'organization_name': 'unknown_org',
        'organization_plan': 'claude_free',
        '5h': 0,
        '7d': 0
    }
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'profile.json'), JSON.stringify(fallback, null, 2))

    const profilesFile = path.join(cacheDir, 'profiles.json')
    let profiles = {}
    try {
        profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8')) || {}
    } catch (e) {
        profiles = {}
    }
    profiles[fallback.uuid] = fallback
    fs.writeFileSync(profilesFile, JSON.stringify(profiles, null, 2))

    return fallback
}

// 备份当前账号：把现存的账号顶层目录移动到 MagicClaude/{uuid}，复制失败时原数据不受影响
// 备份写完后写入 .complete 标记；标记已存在说明上次已备份成功（启动失败后重试时不再覆盖备份）
// profile.json 没有 uuid 时先写入兜底 profile，再继续备份，不再跳过
function backupCurrentAccount(cacheDir) {
    const live = liveRels()
    let uuid = readCurrentUuid(cacheDir)
    console.log('[account-restore] backup: uuid', uuid, 'live dirs', live)
    if (!uuid) {
        uuid = writeFallbackProfile(cacheDir).uuid
        console.log('[account-restore] no uuid in profile.json, wrote fallback profile', uuid)
    }

    const targetDir = path.join(cacheDir, uuid)
    const marker = path.join(targetDir, '.complete')
    trace(cacheDir, `backup uuid=${uuid} live=${JSON.stringify(live)} marker=${lexists(marker)}`)
    if (lexists(marker)) {
        console.log('account already backed up', uuid)
        return
    }
    // 启动钩子运行在新进程中、旧进程已退出，直接改名移动，比复制再删除快得多
    // 中途失败时已移走的目录留在备份里，下次启动重试时只移动剩下的部分
    for (const rel of live) {
        console.log('[account-restore] backup moving', rel, '->', path.join(targetDir, rel))
        moveDir(liveDir(rel), path.join(targetDir, rel))
        trace(cacheDir, `moved ${rel}`)
        console.log('[account-restore] backup moved', rel)
    }
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(marker, '')
    trace(cacheDir, `backup complete ${uuid}`)
    console.log('[account-restore] backup complete', uuid)
}


// 诊断日志：每一步追加写入 MagicClaude/account-trace.log，便于真机排查
function trace(cacheDir, line) {
    fs.appendFileSync(path.join(cacheDir, 'account-trace.log'), `${new Date().toISOString()} ${line}\n`)
}

// 启动时执行 MagicClaude/custom_env.json 中的 accountAction（global_main.js 在迁移 custom_env.json 之前同步调用，此时窗口与数据库都还没有打开）
// accountAction 结构：
//   { type: 'clear' }                                  备份当前账号，清空账号目录（添加账号时使用，新账号从空目录开始）
//   { type: 'restore', from: <目标账号目录>, profile }  备份当前账号，清空账号目录，把 from 中的目录移回原位，并写入 profile.json
// 还原过程中写入 .restoring 标记，下次启动发现它存在时说明上次还原中途失败、目标账号目录已经不完整，直接报错，不再继续覆盖
// 备份失败时直接抛出，此时还没有删除任何数据；action 由调用方在成功后才清除，失败后下次启动会重试
function applyPendingAction(cacheDir, action) {
    console.log('[account-restore] applyPendingAction type', action.type, 'from', action.from || null)
    trace(cacheDir, `apply ${action.type} execPath=${process.execPath} appData=${process.env.APPDATA} localAppData=${process.env.LOCALAPPDATA}`)
    if (action.type === 'restore') {
        if (lexists(path.join(action.from, '.restoring'))) {
            console.log('[account-restore] .restoring marker found in', action.from)
            throw new Error(`上次还原中途失败，目标账号目录不完整：${action.from}`)
        }
        if (!isAccountComplete(action.from)) {
            console.log('[account-restore] target account incomplete', action.from)
            throw new Error(`目标账号数据不完整：${action.from}`)
        }
        console.log('[account-restore] target account ok', action.from)
    }

    console.log('[account-restore] step 1 backupCurrentAccount')
    backupCurrentAccount(cacheDir)
    console.log('[account-restore] step 1 done')

    console.log('[account-restore] step 2 clear live dirs', liveRels())
    for (const rel of liveRels()) {
        retryBusy(() => fs.rmSync(liveDir(rel), { recursive: true, force: true }))
        console.log('[account-restore] cleared', rel)
    }
    console.log('[account-restore] step 2 done')

    if (action.type === 'restore') {
        console.log('[account-restore] step 3 move target dirs into place')
        fs.writeFileSync(path.join(action.from, '.restoring'), '')
        for (const rel of accountRels().filter((rel) => lexists(path.join(action.from, rel)))) {
            moveDir(path.join(action.from, rel), liveDir(rel))
            console.log('[account-restore] restored', rel)
        }
        // 移走后备份里只剩空的顶层文件夹（AppData、LocalAppData 等）和标记文件，清掉，否则下次备份时会因为"不为空"而失败
        for (const name of fs.readdirSync(action.from)) {
            retryBusy(() => fs.rmSync(path.join(action.from, name), { recursive: true, force: true }))
        }
        console.log('[account-restore] step 3 done, writing profile.json')
        fs.writeFileSync(path.join(cacheDir, 'profile.json'), JSON.stringify(action.profile, null, 2))
    } else {
        console.log('[account-restore] step 3 clear, writing empty profile.json')
        fs.writeFileSync(path.join(cacheDir, 'profile.json'), JSON.stringify({}, null, 2))
    }
    console.log('[account-restore] applyPendingAction complete')
}


module.exports = { isAccountComplete, applyPendingAction }
