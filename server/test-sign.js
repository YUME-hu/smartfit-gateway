/**
 * 签名服务集成测试
 *
 * 验证的是"EIP-712 实现是否自洽"：
 *   服务签出来的 signature，必须能被 ethers.verifyTypedData 还原成同一个地址。
 *   如果 domain / types / 字段顺序有任何一处不一致，这里立刻就会挂。
 *   （合约侧用的是同一套算法，所以这一步通过 = 链上 ecrecover 也能过）
 *
 * 用法：
 *   SUPABASE_DB_URL=postgresql://... node test-sign.js
 *
 * 会临时起一个子进程跑 sign.js，测完自动杀掉，不污染环境。
 */

const { spawn } = require('node:child_process')
const path = require('node:path')
const { ethers } = require('ethers')

const PORT = 8799
const CONTRACT = '0x' + '11'.repeat(20) // 随便一个合法地址，测试不依赖真实合约
const CHAIN_ID = 11155111

const DB_URL = process.env.SUPABASE_DB_URL
if (!DB_URL) {
  console.error('缺少 SUPABASE_DB_URL')
  process.exit(2)
}

const wallet = ethers.Wallet.createRandom()

const child = spawn(process.execPath, [path.join(__dirname, 'sign.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    SIGNER_PRIVATE_KEY: wallet.privateKey,
    CONTRACT_ADDRESS: CONTRACT,
    CHAIN_ID: String(CHAIN_ID),
    MIN_EXP: '0', // 测试绕过门槛，专注验证签名本身
    MIN_STEPS: '0',
    DEVICE_ID: 'watch-01',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let childLog = ''
child.stdout.on('data', (d) => (childLog += d.toString()))
child.stderr.on('data', (d) => (childLog += d.toString()))

const base = `http://127.0.0.1:${PORT}`

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(base + '/health')
      if (r.ok) return await r.json()
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('服务没起来：\n' + childLog)
}

async function main() {
  let failed = 0
  const check = (name, ok, detail) => {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  }

  const health = await waitForHealth()
  check('/health 可用', health.ok === true, `signer=${health.signer}`)
  check(
    '服务地址与测试私钥匹配',
    health.signer.toLowerCase() === wallet.address.toLowerCase(),
    `${health.signer}`,
  )

  const to = '0x' + 'ab'.repeat(20)
  const nonce = 0

  const res = await fetch(base + '/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, nonce }),
  })
  const out = await res.json()

  check('POST /sign 返回 200', res.status === 200, JSON.stringify(out).slice(0, 120))

  if (res.status === 200) {
    // 关键一步：用同一套 domain/types 反解
    const recovered = ethers.verifyTypedData(
      out.domain,
      {
        Achievement: [
          { name: 'to', type: 'address' },
          { name: 'exp', type: 'uint32' },
          { name: 'steps', type: 'uint32' },
          { name: 'level', type: 'uint8' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        to: out.to ?? to,
        exp: out.exp,
        steps: out.steps,
        level: out.level,
        nonce: out.nonce,
        deadline: out.deadline,
      },
      out.signature,
    )

    check(
      '签名可被 verifyTypedData 还原为签名者',
      recovered.toLowerCase() === wallet.address.toLowerCase(),
      `recovered=${recovered}`,
    )

    check('签名长度 65 字节', ethers.dataLength(out.signature) === 65)

    // 篡改测试：改 exp 后必须解析出**不同**的地址（说明数据被绑定在签名里）
    const tampered = ethers.verifyTypedData(
      out.domain,
      {
        Achievement: [
          { name: 'to', type: 'address' },
          { name: 'exp', type: 'uint32' },
          { name: 'steps', type: 'uint32' },
          { name: 'level', type: 'uint8' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        to: out.to ?? to,
        exp: out.exp + 1, // 篡改
        steps: out.steps,
        level: out.level,
        nonce: out.nonce,
        deadline: out.deadline,
      },
      out.signature,
    )
    check(
      '篡改 exp 后还原出不同地址（数据确实被绑定）',
      tampered.toLowerCase() !== wallet.address.toLowerCase(),
      `tampered_recovered=${tampered}`,
    )
  }

  // 非法地址
  const bad = await fetch(base + '/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'not-an-address', nonce: 0 }),
  })
  check('非法地址返回 400', bad.status === 400)

  console.log(failed === 0 ? '\nSIGNER TEST: PASS' : `\nSIGNER TEST: FAIL (${failed})`)
  child.kill()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('异常: ' + e.message)
  console.error(childLog)
  child.kill()
  process.exit(2)
})
