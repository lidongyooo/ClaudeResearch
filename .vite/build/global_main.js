// 时区固定为纽约，必须在加载其他模块前设置
process.env.TZ = 'America/New_York'

const { app, ipcMain, BrowserWindow, Menu, MenuItem, nativeTheme, session } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

try { require('./global_session.js').install() } catch (err) { console.error('global_session load failed', err) }

let myele = require("electron");

// AES 密钥与 IV 共用：原始字符串为 15 字节，不足 16 字节时末尾补 0
const AES_KEY_IV = Buffer.alloc(16)
Buffer.from('123456789123456').copy(AES_KEY_IV)

myele.app.commandLine.appendSwitch('lang', 'en-US')
myele.app.commandLine.appendSwitch('accept-lang', 'en-US,en')

// 账号切换的备份与还原按平台分派：darwin 走 global_main_for_mac.js（钥匙串 + 数据目录），win32 走 global_main_for_windows.js
// 只在对应平台上 require，避免 mac 专用的 safe_storage.node 在 Windows 上加载失败
const accountBackend = process.platform === 'darwin'
    ? require('./global_main_for_mac.js')
    : process.platform === 'win32'
        ? require('./global_main_for_windows.js')
        : {
            saveCurrentAccount: async () => { throw new Error(`账号切换暂不支持 ${process.platform}`) },
            restoreAccount: async () => { throw new Error(`账号切换暂不支持 ${process.platform}`) },
            isAccountComplete: () => false,
            applyPendingAction: () => { throw new Error(`账号切换暂不支持 ${process.platform}`) }
        }

// 启动时先执行 Windows 账号切换动作（MagicClaude/custom_env.json 的 accountAction：备份当前账号，清空后还原目标账号）
// 执行成功后才删除该文件；执行失败时保留动作，下次启动重试，并写入 switch-error.log，不阻止启动
function runPendingAccountAction() {
    console.log('[account-restore] runPendingAccountAction start, platform', process.platform)
    if (process.platform !== 'win32') return
    const cacheDir = path.join(app.getPath('appData'), 'MagicClaude')
    const magicEnvPath = path.join(cacheDir, 'custom_env.json')
    console.log('[account-restore] cacheDir', cacheDir, 'magicEnvPath exists', lexists(magicEnvPath))
    if (!lexists(magicEnvPath)) return
    try {
        const env = decryptJson(fs.readFileSync(magicEnvPath, 'utf8'))
        console.log('[account-restore] decrypted custom_env keys', env ? Object.keys(env) : null)
        if (!env || !env.accountAction) {
            console.log('[account-restore] no accountAction, skip')
            return
        }
        const { accountAction } = env
        console.log('[account-restore] accountAction type', accountAction.type, 'from', accountAction.from || null)
        accountBackend.applyPendingAction(cacheDir, accountAction)
        // 动作已执行成功，删除动作文件；失败时保留，下次启动重试
        fs.rmSync(magicEnvPath, { force: true })
        console.log('[account-restore] removed custom_env.json after action')
        console.log('applied account action', accountAction.type)
    } catch (e) {
        console.error('[account-restore] FAILED at runPendingAccountAction', e)
        console.error('apply account action failed', e)
        fs.writeFileSync(path.join(cacheDir, 'switch-error.log'), String((e && e.stack) || e))
    }
}
runPendingAccountAction()

// 同步睡眠：无条件阻塞当前线程至少 ms 毫秒。首选 Atomics.wait（阻塞但不占 CPU），
// 环境不支持（如浏览器主线程）时退化为忙等，保证一定睡够
function sleepSync(ms) {
    const end = Date.now() + ms
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
        return
    } catch (e) { }
    while (Date.now() < end) { }
}


function platformCapCheck () {
    if (process.platform !== 'darwin') return
    // 连续读取两次钥匙串条目，全部成功且总耗时在 2 秒以内，才视为"始终允许"（不会出现系统授权框）
    // 否则说明读取在等待授权，弹提示框后重新读取，让系统授权框出现。
    //
    // 探测必须使用真正的 Claude Safe Storage service，否则检测不到 Electron
    // 实际使用的那把钥匙串条目。写入时必须先读：只有确认条目不存在时才创建，
    // 绝不能覆盖已有的真实密钥，否则所有账号的 Cookies 都会无法解密。
    const safeStorage = require('./native/safe_storage.node')
    const PROBE_SERVICE = 'Claude Safe Storage'
    const PROBE_ACCOUNT = 'Claude Key'
    const PROBE_LABEL = 'Claude Safe Storage'
    // 仅在条目不存在时使用。随机生成，避免把固定字符串变成真实密钥。
    const PROBE_SECRET = crypto.randomBytes(16).toString('base64')

    let existing = null
    let readError = null
    try {
        existing = safeStorage.readSafeStorage(PROBE_SERVICE)
    } catch (err) {
        readError = err
        console.error('[keychain] initial read failed:', err.message)
    }

    // 只有读取成功且确实没有条目时才创建；读取抛错（例如等待授权）时不写。
    if (!readError && (!existing || !existing.password || existing.password.length === 0)) {
        try {
            safeStorage.writeSafeStorage(PROBE_SERVICE, PROBE_ACCOUNT, PROBE_LABEL, PROBE_SECRET)
        } catch (err) {
            console.error('[keychain] initial write failed:', err.message)
        }
    }

    const TIMES = 2
    const LIMIT_MS = 1500
    const readOnce = () => {
        // 这里只校验能读到非空密码，不比较固定字符串：
        // 已有真实密钥时读到的就是真实密钥，不能要求它等于 PROBE_SECRET。
        const item = safeStorage.readSafeStorage(PROBE_SERVICE)
        return !!item && !!item.password && item.password.length > 0
    }
    while (true) {
        const start = Date.now()
        let allOk = true
        for (let i = 0; i < TIMES && allOk; i++) {
            try {
                allOk = readOnce()
            } catch (err) {
                console.error('[keychain] read failed:', err.message)
                allOk = false
            }
        }
        const elapsed = Date.now() - start
        if (allOk && elapsed < LIMIT_MS) return
        myele.dialog.showMessageBoxSync({
            type: 'warning',
            message: 'Claude 必须具有 Claude Safe Storage 钥匙串的访问能力，否则将丢失登录态信息。\n\n请点击左侧的：始终允许',
            buttons: ['好的'],
        })
    }
}

// mac：探测钥匙串访问权限（用应用自有的探测条目），无权限时提示用户始终允许访问
myele.app.whenReady().then(async () => {
    platformCapCheck()
})


myele.app.whenReady().then(
    async () => {
        {
            const preloadPath = require("path").join(__dirname, "global_preload.js");
            const addPreload = (ses) => {
                try {
                    if (typeof ses.registerPreloadScript === "function") {
                        ses.registerPreloadScript({ type: "frame", filePath: preloadPath });
                    } else {
                        ses.setPreloads([...ses.getPreloads(), preloadPath]);
                    }
                } catch (err) {
                    console.error("global_preload inject failed", err);
                }
            };
            addPreload(myele.session.defaultSession);
            myele.app.on("session-created", addPreload);
        }
        
        const US_LOCALE = 'en-US'
        const US_LANGS = ['en-US', 'en']
        const US_COUNTRY = 'US'

        function forceUSNative() {
            // 逐个用 defineProperty 覆盖（这些是 prototype/实例上的 getter，可覆盖）
            const overrides = {
                getLocale: () => US_LOCALE,
                getSystemLocale: () => US_LOCALE,
                getPreferredSystemLanguages: () => [...US_LANGS],
                getLocaleCountryCode: () => US_COUNTRY,
            }

            for (const [name, fn] of Object.entries(overrides)) {
                try {
                    Object.defineProperty(myele.app, name, {
                        configurable: true,
                        enumerable: true,
                        writable: true,
                        value: fn,
                    })
                } catch (e) {
                    console.warn(`[forceUS] hook ${name} failed:`, e.message)
                }
            }
        }

        forceUSNative()

    }
)

// 对象 → JSON → AES-128-CBC 加密 → base64
function encryptJson(obj) {
    const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY_IV, AES_KEY_IV)
    return Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]).toString('base64')
}

// base64 → AES-128-CBC 解密 → JSON → 对象，密文无效时抛出异常
function decryptJson(text) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', AES_KEY_IV, AES_KEY_IV)
    return JSON.parse(Buffer.concat([decipher.update(text, 'base64'), decipher.final()]).toString('utf8'))
}

let switchAccountWin = null

function openSwitchAccountWindow() {
    platformCapCheck()
    if (switchAccountWin && !switchAccountWin.isDestroyed()) {
        switchAccountWin.show()
        switchAccountWin.focus()
        return
    }
    switchAccountWin = new BrowserWindow({
        width: 600,
        height: 800,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#151515' : '#fcfcfb',
        title: 'Switch Account',
        titleBarStyle: 'hiddenInset'
    })
    switchAccountWin.loadFile(path.join(app.getAppPath(), '.vite/renderer/switch_account/switch_account.html'))
    switchAccountWin.on('closed', () => (switchAccountWin = null))
}

ipcMain.removeHandler('global:openSwitchAccount')
ipcMain.handle('global:openSwitchAccount', () => openSwitchAccountWindow())

// 顶部导航栏：在应用菜单末尾添加 "Switch account"，点击打开账号切换窗口
// 应用自己的菜单是异步构建的，这里延迟到其设置完成后再追加，原有菜单项保持不变
// 顶部导航栏：应用菜单每次被设置后，在末尾追加 "Switch account"（点击打开账号切换窗口）
// 应用菜单是异步构建并设置的，直接延迟追加会因时序不稳定而失效，所以包装 setApplicationMenu，在设置完成后立即追加
const originalSetApplicationMenu = Menu.setApplicationMenu.bind(Menu)
Menu.setApplicationMenu = (menu) => {
    if (menu) {
        menu.append(
            new MenuItem({
                label: 'Switch account',
                submenu: [
                    {
                        label: 'Switch account…',
                        click: () => openSwitchAccountWindow()
                    }
                ]
            })
        )
    }
    originalSetApplicationMenu(menu)
}

// 调试：每个 webContents 在 loadURL 前先打开 DevTools
// 窗口由 BrowserWindow 创建，webContents 创建时触发 web-contents-created，在这里包装实例上的 loadURL
app.on('web-contents-created', (_event, contents) => {
    const originalLoadURL = contents.loadURL.bind(contents)
    
    contents.loadURL = (url, options) => {
        return originalLoadURL(url, options)
    }
})

// 兜底：如果应用菜单在包装生效之前就已设置，补设一次（此时 getApplicationMenu 返回的是已有菜单）
app.whenReady().then(() => {
    const current = Menu.getApplicationMenu()
    if (current && !current.items.some((i) => i.label === 'Switch account')) {
        Menu.setApplicationMenu(current)
    }
})


// 读取 Claude 自身的账号信息与用量（沿用已登录的 Claude 会话）
async function getUserData() {
    let list = await session.defaultSession.cookies.get({ domain: 'claude.ai' })
    let sessionKey = ''
    let lastActiveOrg = ''
    for (let item of list) {
        if (item.name === 'sessionKey') {
            sessionKey = item.value
        } else if (item.name === 'lastActiveOrg') {
            lastActiveOrg = item.value
        }
    }

    if (!sessionKey || !lastActiveOrg) {
        return {}
    }

    // 走 Chromium 网络栈，自动携带 session 中的全部 cookie（含 sessionKey、cf_clearance）
    const headers = {
        Accept: 'application/json'
    }
    const urls = {
        usage: `https://claude.ai/api/organizations/${lastActiveOrg}/usage`,
        account: 'https://claude.ai/api/account'
    }

    const [usage, account] = await Promise.all(
        Object.values(urls).map(async (url) => {
            try {
                const res = await session.defaultSession.fetch(url, { headers, credentials: 'include' })
                if (!res.ok) {
                    return { error: `HTTP ${res.status}` }
                }
                return await res.json()
            } catch (e) {
                return { error: String(e) }
            }
        })
    )

    return { usage, account }
}

ipcMain.removeHandler('global:getUserData')
ipcMain.handle('global:getUserData', () => getUserData())

async function saveUserData() {
    const cacheDir = path.join(app.getPath('appData'), 'MagicClaude')
    fs.mkdirSync(cacheDir, { recursive: true })
    for (const name of ['profile.json', 'profiles.json']) {
        const file = path.join(cacheDir, name)
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify({}, null, 2))
        }
    }

    const { usage, account } = await getUserData()
    // Claude 账号信息不可用（未登录或请求失败）时不写坏数据，直接返回
    if (!account || account.error || !account.uuid || !Array.isArray(account.memberships) || !account.memberships[0]) {
        console.error('save user data skipped: account info unavailable', account)
        return cacheDir
    }
    const profileJson = {
        'uuid': account.uuid,
        'email_address': account.email_address,
        'full_name': account.full_name,
        'organization_id': account.memberships[0].organization.uuid,
        'organization_name': account.memberships[0].organization.name,
        'organization_plan': account.memberships[0].organization.analytics_subscription_plan,
        '5h': 'five_hour' in usage && usage.five_hour ? usage.five_hour.utilization : 0,
        '7d': 'seven_day' in usage && usage.seven_day ? usage.seven_day.utilization : 0
    }

    // profile.json 整体覆盖
    fs.writeFileSync(path.join(cacheDir, 'profile.json'), JSON.stringify(profileJson, null, 2))

    // profiles.json 只覆盖 uuid 这一个键,其他键保持
    const profilesFile = path.join(cacheDir, 'profiles.json')
    let profiles = {}
    try {
        profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8')) || {}
    } catch (e) {
        profiles = {}
    }
    profiles[profileJson.uuid] = profileJson
    fs.writeFileSync(profilesFile, JSON.stringify(profiles, null, 2))

    return cacheDir
}

ipcMain.removeHandler('global:saveUserData')
ipcMain.handle('global:saveUserData', () => saveUserData())


async function getAllProfile() {
    const cacheDir = path.join(app.getPath('appData'), 'MagicClaude')
    const readJson = (name) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8'))
        } catch (e) {
            return null
        }
    }
    return { profile: readJson('profile.json'), profiles: readJson('profiles.json') }
}

ipcMain.removeHandler('global:getAllProfile')
ipcMain.handle('global:getAllProfile', () => getAllProfile())

function lexists(p) {
    try {
        fs.lstatSync(p)
        return true
    } catch (e) {
        return false
    }
}

// 写入 MagicClaude/custom_env.json：只写 accountAction，下次启动时由 runPendingAccountAction 执行并清除
// 只在 Windows 上有读取方，mac 版不使用
function writeAccountAction(cacheDir, action) {
    if (process.platform !== 'win32') return
    const envPath = path.join(cacheDir, 'custom_env.json')
    fs.writeFileSync(envPath, encryptJson({ accountAction: action }))
}

// 添加账号：不校验任何卡密/邮箱，清空当前账号后重启，后续登录与验证全部由用户手动完成
// Windows：备份当前账号并清空在下次启动时执行（旧进程仍占用数据文件，无法在这里复制），profile.json 由钩子清空
// mac：保存当前账号（钥匙串与数据目录），随后清空 profile.json，失败原因写入 switch-error.log
async function addAccount() {
    const cacheDir = path.join(app.getPath('appData'), 'MagicClaude')
    fs.mkdirSync(cacheDir, { recursive: true })

    for (const win of BrowserWindow.getAllWindows()) {
        win.destroy()
    }

    if (process.platform === 'win32') {
        writeAccountAction(cacheDir, { type: 'clear' })
    } else {
        try {
            await session.defaultSession.cookies.flushStore()
            await accountBackend.saveCurrentAccount()
        } catch (e) {
            console.error('add account failed', e)
            fs.writeFileSync(path.join(cacheDir, 'switch-error.log'), String((e && e.stack) || e))
        }
        // 清空 profile.json，避免重启后仍指向已移走的旧账号（无论保存成功、跳过或失败都要清空）
        fs.writeFileSync(path.join(cacheDir, 'profile.json'), JSON.stringify({}, null, 2))
    }

    app.relaunch()
    app.exit(0)
    return { ok: true }
}

ipcMain.removeHandler('global:addAccount')
ipcMain.handle('global:addAccount', () => addAccount())

// 切换账号：校验目标 → 关闭所有窗口 → 重启应用
// 目标校验在任何修改之前完成，目标不完整时直接报错，不动任何数据
// Windows：备份当前账号并还原目标账号在下次启动时执行（此时旧进程已退出，文件可以改名移动）
// mac：保存当前账号后还原目标账号，无论成功或失败都重启，失败原因写入 switch-error.log
async function switchToAccount(uuid) {
    const cacheDir = path.join(app.getPath('appData'), 'MagicClaude')
    const profile = JSON.parse(fs.readFileSync(path.join(cacheDir, 'profile.json'), 'utf8'))
    if (uuid === profile.uuid) {
        throw new Error('目标账号就是当前账号')
    }

    const profiles = JSON.parse(fs.readFileSync(path.join(cacheDir, 'profiles.json'), 'utf8'))
    if (!profiles[uuid]) {
        throw new Error(`profiles.json 中没有账号 ${uuid}`)
    }
    const targetDir = path.join(cacheDir, uuid)
    if (!accountBackend.isAccountComplete(targetDir)) {
        throw new Error(`目标账号数据不完整：${targetDir}`)
    }

    for (const win of BrowserWindow.getAllWindows()) {
        win.destroy()
    }

    if (process.platform === 'win32') {
        writeAccountAction(cacheDir, { type: 'restore', from: targetDir, profile: profiles[uuid] })
    } else {
        try {
            await session.defaultSession.cookies.flushStore()
            await accountBackend.saveCurrentAccount()
            await accountBackend.restoreAccount(uuid, cacheDir, targetDir)
        } catch (e) {
            console.error('switch account failed', e)
            fs.writeFileSync(path.join(cacheDir, 'switch-error.log'), String((e && e.stack) || e))
        }
    }

    app.relaunch()
    app.exit(0)
}

ipcMain.removeHandler('global:switchToAccount')
ipcMain.handle('global:switchToAccount', (_event, uuid) => switchToAccount(uuid))

// 重启应用：渲染端需要重新开始时调用
ipcMain.removeHandler('global:restartApp')
ipcMain.handle('global:restartApp', () => {
    app.relaunch()
    app.exit(0)
})


async function getAllCookies() {
    return await session.defaultSession.cookies.get({})
}

ipcMain.removeHandler('global:getAllCookies')
ipcMain.handle('global:getAllCookies', () => getAllCookies())
