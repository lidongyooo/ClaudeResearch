// macOS 账号切换的备份与还原：Claude Safe Storage 钥匙串条目 + 数据目录搬移
// 由 global_main.js 在 darwin 平台上引入；Windows 版待实现
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const CLAUDE_BUNDLE_ID = 'com.anthropic.claudefordesktop'
const SAFE_STORAGE_SERVICE = 'Claude Safe Storage'

function lexists(p) {
    try {
        fs.lstatSync(p)
        return true
    } catch (e) {
        return false
    }
}

// 需要随账号切换的数据，返回相对于 base 的路径（base 为用户 home，或 MagicClaude/{uuid}）
function claudeRelPaths(base) {
    const rels = [
        'Library/Application Support/Claude',
        'Library/Application Support/Claude-3p',
        'Library/Logs/Claude',
        `Library/Caches/${CLAUDE_BUNDLE_ID}`,
        `Library/Caches/${CLAUDE_BUNDLE_ID}.ShipIt`,
        `Library/HTTPStorages/${CLAUDE_BUNDLE_ID}`,
        `Library/Saved Application State/${CLAUDE_BUNDLE_ID}.savedState`
    ].filter((rel) => lexists(path.join(base, rel)))
    const prefsDir = path.join(base, 'Library/Preferences')
    if (lexists(prefsDir)) {
        for (const name of fs.readdirSync(prefsDir)) {
            if (name.startsWith(CLAUDE_BUNDLE_ID) && name.endsWith('.plist')) {
                rels.push(`Library/Preferences/${name}`)
            }
        }
    }
    return rels
}

// 把 rels 从 fromBase 移动到 toBase；中途失败时把已移动的项移回 fromBase
function moveRels(rels, fromBase, toBase) {
    const done = []
    try {
        for (const rel of rels) {
            fs.mkdirSync(path.dirname(path.join(toBase, rel)), { recursive: true })
            fs.renameSync(path.join(fromBase, rel), path.join(toBase, rel))
            done.push(rel)
        }
    } catch (e) {
        for (const rel of done.reverse()) {
            fs.renameSync(path.join(toBase, rel), path.join(fromBase, rel))
        }
        throw e
    }
}

// 原生模块：直接调用 Security framework 读写 Claude Safe Storage，不经过 security 子进程
const safeStorageNative = require('./native/safe_storage.node')

// 读取 Claude Safe Storage 条目；密码以 hex 保存（与 keychain.json 的既有格式一致）；条目不存在时返回 null
function readSafeStorageKey() {
    const item = safeStorageNative.readSafeStorage(SAFE_STORAGE_SERVICE)
    if (!item) {
        return null
    }
    return {
        service: item.service,
        account: item.account,
        label: item.label,
        password_hex: item.password.toString('hex')
    }
}

// 写入 Claude Safe Storage 条目；已存在则更新密码，不存在则新增
function restoreSafeStorageKey(item) {
    safeStorageNative.writeSafeStorage(
        item.service,
        item.account,
        item.label,
        Buffer.from(item.password_hex, 'hex')
    )
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

// 保存当前账号：先写入钥匙串备份，再把数据目录移入 MagicClaude/{uuid}，最后删除钥匙串条目
// profile.json 不存在、无法解析或没有 uuid 时先写入兜底 profile，再继续备份，不中断
async function saveCurrentAccount() {
    const cacheDir = path.join(app.getPath('appData'), 'MagicClaude')
    let profile = null
    try {
        profile = JSON.parse(fs.readFileSync(path.join(cacheDir, 'profile.json'), 'utf8'))
    } catch (e) {
        profile = null
    }
    if (!profile || !profile.uuid) {
        profile = writeFallbackProfile(cacheDir)
        console.log('no uuid in profile.json, wrote fallback profile', profile.uuid)
    }
    const currentUuid = profile.uuid

    const targetDir = path.join(cacheDir, currentUuid)
    if (lexists(targetDir) && fs.readdirSync(targetDir).length > 0) {
        throw new Error(`${targetDir} 不为空，已取消保存`)
    }
    fs.mkdirSync(targetDir, { recursive: true })

    const keychain = await readSafeStorageKey()
    const keychainFile = path.join(targetDir, 'keychain.json')
    fs.writeFileSync(keychainFile, JSON.stringify(keychain, null, 2), { mode: 0o600 })

    const rels = claudeRelPaths(os.homedir())
    try {
        moveRels(rels, os.homedir(), targetDir)
    } catch (e) {
        fs.rmSync(keychainFile, { force: true })
        throw e
    }

    // if (keychain) {
    //     safeStorageNative.deleteSafeStorage(SAFE_STORAGE_SERVICE)
    // }
    
    console.log('saved account', currentUuid, rels)
    return { saved: true, uuid: currentUuid }
}

// 还原目标账号：先恢复钥匙串，再把数据搬回 home，更新 profile.json，最后清空 MagicClaude/{uuid}
// 原位置已有的内容移到 MagicClaude/_leftover/<时间>/，不直接删除
async function restoreAccount(uuid, cacheDir, targetDir) {
    const keychain = JSON.parse(fs.readFileSync(path.join(targetDir, 'keychain.json'), 'utf8'))
    if (keychain) {
        await restoreSafeStorageKey(keychain)
    }

    const leftover = path.join(cacheDir, '_leftover', new Date().toISOString().replace(/[:.]/g, '-'))
    for (const rel of claudeRelPaths(targetDir)) {
        const dest = path.join(os.homedir(), rel)
        if (lexists(dest)) {
            fs.mkdirSync(path.dirname(path.join(leftover, rel)), { recursive: true })
            fs.renameSync(dest, path.join(leftover, rel))
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.renameSync(path.join(targetDir, rel), dest)
    }

    const profiles = JSON.parse(fs.readFileSync(path.join(cacheDir, 'profiles.json'), 'utf8'))
    fs.writeFileSync(path.join(cacheDir, 'profile.json'), JSON.stringify(profiles[uuid], null, 2))

    for (const name of fs.readdirSync(targetDir)) {
        fs.rmSync(path.join(targetDir, name), { recursive: true, force: true })
    }
}

// 目标账号数据是否完整（keychain.json 存在）
function isAccountComplete(targetDir) {
    return lexists(path.join(targetDir, 'keychain.json'))
}

module.exports = { saveCurrentAccount, restoreAccount, isAccountComplete }
