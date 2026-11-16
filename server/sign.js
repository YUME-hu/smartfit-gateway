/**
 * SmartFit 里程碑成就 —— EIP-712 签名服务
 *
 * 职责：把"链上不可信数据"这件事补上。
 *   浏览器只负责说"我是谁"（地址）和"我要第几次签名"（nonce），
 *   **经验/步数/等级由本服务从数据库读出来**，再用私钥签名。
 *   于是浏览器改不了数字 —— 改了就验不过 ecrecover。
 *
 * 为什么用 node:http 而不是 Express/Fastify：
 *   两个路由，零依赖，100 多行就够。少一个框架少一堆供应链风险。
 *
 * 启动：
 *   cd server && npm install
 *   SIGNER_PRIVATE_KEY=0x... \
 *   SUPABASE_DB_URL=postgresql://... \
 *   CONTRACT_ADDRESS=0x... \
 *   npm start
 *
 * ⚠️ 安全边界（答辩要讲）：
 *   1. 这个私钥只能是**测试网专用**，绝不能是真钱钱包
 *   2. 默认只监听 127.0.0.1；部署到公网必须加鉴权 + HTTPS
 *   3. 服务不落盘、不记日志里的敏感信息
 *   4. 数据库连接**校验证书**：默认用系统 CA；自签实例通过 SUPABASE_CA_CERT 指定 CA
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { ethers } = require('ethers')
const { Pool } = require('pg')

// ---------------------------------------------------------------- 配置

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'

const SIGNER_PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY || ''
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || ''
/** 数据库 TLS 的 CA：PEM 字符串（-----BEGIN 开头）或文件路径（相对 server/）。留空 = 系统 CA */
const SUPABASE_CA_CERT = process.env.SUPABASE_CA_CERT || ''
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || ''
const CHAIN_ID = Number(process.env.CHAIN_ID || 11155111) // Sepolia
const DEVICE_ID = process.env.DEVICE_ID || 'watch-01'

const MIN_EXP = Number(process.env.MIN_EXP ?? 300)
const MIN_STEPS = Number(process.env.MIN_STEPS ?? 5000)
/** 签名有效期（秒） */
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 600)

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*'

// ---------------------------------------------------------------- 校验配置

function fail(msg) {
  console.error('[signer] ' + msg)
  process.exit(1)
}

if (!SIGNER_PRIVATE_KEY) fail('缺少 SIGNER_PRIVATE_KEY')
if (!SUPABASE_DB_URL) fail('缺少 SUPABASE_DB_URL')
if (!/^0x[0-9a-fA-F]{40}$/.test(CONTRACT_ADDRESS)) fail('CONTRACT_ADDRESS 不是合法地址')
if (/^0x0{40}$/i.test(CONTRACT_ADDRESS)) {
  fail(
    'CONTRACT_ADDRESS 还是占位符。请先用 Remix 部署合约，把地址填进 server/.env 再启动。\n' +
      '        （没有真实合约地址时签名会绑定错误的 verifyingContract，链上必然验不过）',
  )
}

const wallet = new ethers.Wallet(SIGNER_PRIVATE_KEY)
const signerAddress = wallet.address

/**
 * 读取 CA：SUPABASE_CA_CERT 以 -----BEGIN 开头就当 PEM 字符串，否则当文件路径。
 *
 * 路径相对 server/ 解析（__dirname），所以 `SUPABASE_CA_CERT=./certs/supabase-root.pem`
 * 不管从哪个目录启动都指向同一份文件 —— 团队/CI 统一用路径，本地临时贴字符串也行。
 */
function readCaCert(value) {
  const v = (value || '').trim()
  if (!v) return ''
  if (v.startsWith('-----BEGIN')) return v.replace(/\\n/g, '\n')

  const file = path.resolve(__dirname, v)
  if (!fs.existsSync(file)) {
    fail(
      `SUPABASE_CA_CERT 指向的文件不存在: ${file}\n` +
        '        也可以直接把 PEM 内容贴进这个变量（以 -----BEGIN 开头）',
    )
  }
  const pem = fs.readFileSync(file, 'utf8')
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    fail(`SUPABASE_CA_CERT 指向的文件里没有 PEM 证书: ${file}`)
  }
  return pem
}

/**
 * 数据库 TLS 配置
 *
 * 这里没有"关掉校验"的开关：证书校验恒为开，唯一的变量是拿什么当信任锚。
 *   · 配了 SUPABASE_CA_CERT → 用它校验服务端证书（自签 / 私有 CA 的实例）
 *   · 没配 → 不传 ca，交给 Node 的系统 CA 库（公开 CA 签发的实例）
 *
 * pg 的坑（用仓库里这份 pg 实测过）：ConnectionParameters 会把连接串解析结果
 * Object.assign 到显式配置之上（pg/lib/connection-parameters.js:60），所以
 * sslmode=no-verify / disable 能盖掉下面这个 ssl 对象 —— 启动时先由
 * assertDsnSslMode() 把这类写法拦下来。
 *
 * 不替用户"兜底"：CA 不对就握手失败（连不上就是连不上），不会降级成不校验。
 */
function buildPgSsl(caPem) {
  if (!caPem) return { rejectUnauthorized: true }
  return { ca: caPem, rejectUnauthorized: true }
}

const SUPABASE_CA_PEM = readCaCert(SUPABASE_CA_CERT)

/**
 * 拦住"会关掉 TLS / 证书校验"的 sslmode
 *
 * 只放行 verify-full；不写 sslmode 也放行（那就走 buildPgSsl 的配置）。
 * 其余一律拒绝启动。这里不替用户改写连接串 —— 那只会把问题藏起来。这个服务签的是
 * 链上成就，连库那段悄悄不校验，前面做的一切都等于没做。
 */
function assertDsnSslMode(dbUrl) {
  let raw = null
  if (/^postgres(ql)?:\/\//i.test(dbUrl)) {
    try {
      raw = new URL(dbUrl).searchParams.get('sslmode')
    } catch {
      return // 连接串本身不合法时交给 pg 报错，这里不重复校验
    }
  } else {
    // libpq 关键字写法：host=... user=... sslmode=no-verify
    const m = /\bsslmode\s*=\s*['"]?([\w-]+)/i.exec(dbUrl)
    raw = m ? m[1] : null
  }

  if (raw === null) return
  const mode = raw.toLowerCase()
  if (mode === 'verify-full') return

  // 现在就等于"关掉"的两种
  if (mode === 'disable' || mode === 'no-verify') {
    fail(
      `SUPABASE_DB_URL 里的 sslmode=${mode} 会${mode === 'disable' ? '完全不加密' : '关掉证书校验'}（pg 用连接串的值覆盖显式 ssl 配置），已拒绝启动。\n` +
        '        正确做法：从连接串里去掉 sslmode，改用 SUPABASE_CA_CERT 指定要信任的 CA；\n' +
        '        服务端证书由公开 CA 签发时，SUPABASE_CA_CERT 留空即可（走系统 CA）。',
    )
  }

  // 现在恰好等价于 verify-full、但 pg 9 会改成 libpq 语义（不校验证书）的别名
  if (['require', 'verify-ca', 'prefer', 'allow'].includes(mode)) {
    fail(
      `SUPABASE_DB_URL 里的 sslmode=${mode} 在当前 pg 里恰好等价于 verify-full，但 pg 9 会改成 libpq 语义（不校验证书）。\n` +
        '        本服务不依赖这个会变的别名：从连接串里去掉 sslmode，或显式写 sslmode=verify-full。',
    )
  }

  fail(
    `SUPABASE_DB_URL 里的 sslmode=${mode} 不是可接受的值（只接受 verify-full 或留空），已拒绝启动。`,
  )
}

assertDsnSslMode(SUPABASE_DB_URL)

const pool = new Pool({
  connectionString: SUPABASE_DB_URL,
  ssl: buildPgSsl(SUPABASE_CA_PEM),
  max: 4,
})

// ---------------------------------------------------------------- EIP-712 定义
// 必须与合约里的 ACHIEVEMENT_TYPEHASH / DOMAIN_TYPEHASH 完全一致，否则验签失败

const DOMAIN = {
  name: 'SmartFitAchievement',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: CONTRACT_ADDRESS,
}

const TYPES = {
  Achievement: [
    { name: 'to', type: 'address' },
    { name: 'exp', type: 'uint32' },
    { name: 'steps', type: 'uint32' },
    { name: 'level', type: 'uint8' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}

/** 与合约 minExpForLevel / 前端 petRules.ts 保持一致 */
function levelFromExp(exp) {
  if (exp >= 1500) return 5
  if (exp >= 700) return 4
  if (exp >= 300) return 3
  if (exp >= 100) return 2
  return 1
}

// ---------------------------------------------------------------- 业务

/**
 * 从数据库读取该设备的真实运动数据
 *
 * 这是整个方案的关键：**数据源是数据库，不是请求体**。
 * 浏览器就算把 exp 改成 999999，也影响不到签名内容。
 */
async function readPetState() {
  const { rows } = await pool.query(
    `select exp, steps_total from public.pet_state where device_id = $1`,
    [DEVICE_ID],
  )
  if (rows.length === 0) return { exp: 0, steps: 0 }
  return { exp: Number(rows[0].exp), steps: Number(rows[0].steps_total) }
}

async function handleSign(body) {
  const to = String(body?.to || '')
  const nonce = body?.nonce

  if (!ethers.isAddress(to)) {
    return { status: 400, body: { error: 'invalid_address', message: 'to 必须是合法地址' } }
  }
  if (nonce === undefined || nonce === null || !/^\d+$/.test(String(nonce))) {
    return { status: 400, body: { error: 'invalid_nonce', message: 'nonce 必须是非负整数' } }
  }

  const { exp, steps } = await readPetState()

  if (exp < MIN_EXP && steps < MIN_STEPS) {
    return {
      status: 403,
      body: {
        error: 'not_eligible',
        message: `还没达标：需要经验 ≥ ${MIN_EXP} 或累计步数 ≥ ${MIN_STEPS}`,
        exp,
        steps,
      },
    }
  }

  const level = levelFromExp(exp)
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS

  const value = {
    to,
    exp,
    steps,
    level,
    nonce: String(nonce),
    deadline: String(deadline),
  }

  let signature
  try {
    signature = await wallet.signTypedData(DOMAIN, TYPES, value)
  } catch (e) {
    return { status: 500, body: { error: 'sign_failed', message: e.message } }
  }

  console.log(
    `[signer] signed to=${to} exp=${exp} steps=${steps} level=${level} nonce=${nonce}`,
  )

  return {
    status: 200,
    body: {
      signature,
      exp,
      steps,
      level,
      nonce: String(nonce),
      deadline,
      signer: signerAddress,
      domain: { ...DOMAIN },
    },
  }
}

// ---------------------------------------------------------------- HTTP

function send(res, status, payload) {
  const data = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'OPTIONS') return send(res, 204, {})

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      signer: signerAddress,
      contract: CONTRACT_ADDRESS,
      chainId: CHAIN_ID,
      deviceId: DEVICE_ID,
      minExp: MIN_EXP,
      minSteps: MIN_STEPS,
    })
  }

  if (req.method === 'POST' && url.pathname === '/sign') {
    try {
      const body = await readBody(req)
      const out = await handleSign(body)
      return send(res, out.status, out.body)
    } catch (e) {
      return send(res, 500, { error: 'internal', message: e.message })
    }
  }

  send(res, 404, { error: 'not_found' })
})

server.listen(PORT, HOST, () => {
  console.log('[signer] listening on http://' + HOST + ':' + PORT)
  console.log('[signer] signer address : ' + signerAddress)
  console.log('[signer] contract        : ' + CONTRACT_ADDRESS + ' (chain ' + CHAIN_ID + ')')
  console.log('[signer] 门槛            : exp >= ' + MIN_EXP + ' 或 steps >= ' + MIN_STEPS)
})

// 优雅退出，避免 pg 连接池挂着
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('[signer] shutting down')
    server.close(() => pool.end().then(() => process.exit(0)))
  })
}
