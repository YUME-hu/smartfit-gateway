/**
 * 编译合约并产出前端可直接用的 ABI
 *
 * 为什么自己写编译脚本而不是上 Hardhat：
 *   合约是自包含的（没有 import），solc 直接就能编。
 *   Hardhat 会引入 200MB+ 依赖，对"一个合约 + 一次部署"是杀鸡用牛刀。
 *   需要跑测试/脚本化部署时再上 Hardhat 也不迟（README 里给了对照）。
 *
 * 产物：
 *   contracts/artifacts/SmartFitAchievement.json   ABI + bytecode（部署/调试用）
 *   web/src/features/chain/achievementAbi.ts       只含 ABI（前端打包用）
 */

const fs = require('node:fs')
const path = require('node:path')
const solc = require('solc')

const HERE = __dirname
const SRC = path.join(HERE, 'SmartFitAchievement.sol')
const OUT_DIR = path.join(HERE, 'artifacts')
const WEB_ABI = path.join(HERE, '..', 'web', 'src', 'features', 'chain', 'achievementAbi.ts')

const source = fs.readFileSync(SRC, 'utf8')

const input = {
  language: 'Solidity',
  sources: { 'SmartFitAchievement.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
    },
  },
}

const output = JSON.parse(solc.compile(JSON.stringify(input)))

const errors = (output.errors || []).filter((e) => e.severity === 'error')
for (const e of output.errors || []) console.log(e.formattedMessage.trim())
if (errors.length > 0) {
  console.error(`\n编译失败：${errors.length} 个错误`)
  process.exit(1)
}

const contract = output.contracts['SmartFitAchievement.sol'].SmartFitAchievement
const abi = contract.abi
const bytecode = '0x' + contract.evm.bytecode.object
const deployed = '0x' + contract.evm.deployedBytecode.object

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(
  path.join(OUT_DIR, 'SmartFitAchievement.json'),
  JSON.stringify({ abi, bytecode, deployedBytecode: deployed }, null, 2),
)

// 前端只打包 ABI，不打包 bytecode（省体积）
fs.mkdirSync(path.dirname(WEB_ABI), { recursive: true })
const ts = `/**
 * 由 contracts/compile.cjs 自动生成，请勿手改
 * 源合约：contracts/SmartFitAchievement.sol
 */

export const ACHIEVEMENT_ABI = ${JSON.stringify(abi, null, 2)} as const
`
fs.writeFileSync(WEB_ABI, ts)

const size = (deployed.length - 2) / 2
console.log(`\n编译成功`)
console.log(`  ABI 条目      : ${abi.length}`)
console.log(`  部署字节码    : ${size} bytes（上限 24576）`)
console.log(`  artifacts     : contracts/artifacts/SmartFitAchievement.json`)
console.log(`  前端 ABI      : web/src/features/chain/achievementAbi.ts`)
if (size > 24576) {
  console.error('⚠️  超过 EIP-170 限制，无法部署')
  process.exit(1)
}
