/**
 * 里程碑成就上链（MetaMask / Sepolia）
 *
 * 为什么用 ethers v6 而不是 wagmi：
 *   wagmi 是 React 生态（hooks），Vue 需要再包一层；这里只需要
 *   "连钱包 → 发一笔 mint → 等回执"，ethers 直连 window.ethereum 最省事，
 *   体积也小。链上逻辑全部收敛在这一个文件里，换库成本很低。
 *
 * 关键处理：
 *   1. 链不对要主动切（wallet_switchEthereumChain），且处理 4902（未添加该网络）
 *   2. 用户点"拒绝"要和"真正的失败"区分开，否则会误报红
 *   3. 自定义错误（AlreadyMinted / NotEligible）要用 interface.parseError 解出来
 */

import { computed, onBeforeUnmount, ref } from 'vue'
import { BrowserProvider, Contract } from 'ethers'
import { ACHIEVEMENT_ABI } from './achievementAbi'

export const SEPOLIA_CHAIN_ID = 11155111

const SEPOLIA_PARAMS = {
  chainId: '0xaa36a7',
  chainName: 'Sepolia',
  nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.sepolia.org'],
  blockExplorerUrls: ['https://sepolia.etherscan.io'],
}

/** EIP-1193 provider 的最小类型（避免引 @types/ethereum-provider） */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, handler: (...args: any[]) => void): void
  removeListener?(event: string, handler: (...args: any[]) => void): void
}

function injected(): Eip1193 | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null
}

export interface UseMintOptions {
  contractAddress: string
  minExp: number
  minSteps: number
}

export type MintPhase = 'idle' | 'connecting' | 'switching' | 'signing' | 'pending' | 'done' | 'error'

export function useAchievementMint(opts: UseMintOptions) {
  const account = ref<string | null>(null)
  const chainId = ref<number | null>(null)
  const phase = ref<MintPhase>('idle')
  const error = ref<string | null>(null)
  const txHash = ref<string | null>(null)
  const tokenId = ref<string | null>(null)
  const alreadyMinted = ref(false)

  const hasWallet = computed(() => injected() !== null)
  const contractReady = computed(() => /^0x[0-9a-fA-F]{40}$/.test(opts.contractAddress))
  const onSepolia = computed(() => chainId.value === SEPOLIA_CHAIN_ID)
  const canConnect = computed(() => hasWallet.value && contractReady.value)

  function readContract(): Contract | null {
    const eth = injected()
    if (!eth || !contractReady.value) return null
    return new Contract(opts.contractAddress, ACHIEVEMENT_ABI, new BrowserProvider(eth as never))
  }

  async function refreshMinted(): Promise<void> {
    if (!account.value) return
    try {
      const c = readContract()
      if (!c) return
      const bal: bigint = await c.balanceOf(account.value)
      alreadyMinted.value = bal > 0n
      if (bal > 0n) {
        const id: bigint = await c.tokenOf(account.value)
        tokenId.value = id.toString()
      }
    } catch {
      // 读失败不致命（可能没切到 Sepolia），静默
    }
  }

  async function connect(): Promise<void> {
    const eth = injected()
    if (!eth) {
      error.value = '没有检测到 MetaMask，请先安装浏览器插件'
      phase.value = 'error'
      return
    }
    error.value = null
    phase.value = 'connecting'
    try {
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
      account.value = accounts?.[0] ?? null
      chainId.value = Number(await eth.request({ method: 'eth_chainId' }))

      eth.on?.('accountsChanged', (accs: string[]) => {
        account.value = accs?.[0] ?? null
        alreadyMinted.value = false
        tokenId.value = null
        void refreshMinted()
      })
      eth.on?.('chainChanged', (hex: string) => {
        chainId.value = Number(hex)
      })

      phase.value = 'idle'
      await refreshMinted()
    } catch (e) {
      phase.value = 'error'
      error.value = describeError(e)
    }
  }

  async function switchToSepolia(): Promise<boolean> {
    const eth = injected()
    if (!eth) return false
    phase.value = 'switching'
    try {
      await eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: SEPOLIA_PARAMS.chainId }],
      })
      chainId.value = SEPOLIA_CHAIN_ID
      phase.value = 'idle'
      return true
    } catch (e: any) {
      // 4902 = 钱包里没有这个网络，需要 addEthereumChain
      if (e?.code === 4902) {
        try {
          await eth.request({ method: 'wallet_addEthereumChain', params: [SEPOLIA_PARAMS] })
          chainId.value = SEPOLIA_CHAIN_ID
          phase.value = 'idle'
          return true
        } catch (e2) {
          phase.value = 'error'
          error.value = describeError(e2)
          return false
        }
      }
      phase.value = 'error'
      error.value = describeError(e)
      return false
    }
  }

  /** 铸造：exp / steps / level 来自当前宠物状态 */
  async function mint(exp: number, steps: number, level: number): Promise<void> {
    const eth = injected()
    if (!eth || !account.value) {
      error.value = '请先连接钱包'
      phase.value = 'error'
      return
    }
    if (!onSepolia.value) {
      const ok = await switchToSepolia()
      if (!ok) return
    }

    error.value = null
    txHash.value = null
    phase.value = 'signing'
    try {
      const provider = new BrowserProvider(eth as never)
      const signer = await provider.getSigner()
      const c = new Contract(opts.contractAddress, ACHIEVEMENT_ABI, signer)

      const tx = await c.mint(exp, steps, level)
      txHash.value = tx.hash
      phase.value = 'pending'

      const receipt = await tx.wait()
      for (const log of receipt?.logs ?? []) {
        try {
          const parsed = c.interface.parseLog({ topics: log.topics as string[], data: log.data })
          if (parsed?.name === 'AchievementMinted') {
            tokenId.value = parsed.args.tokenId.toString()
          }
        } catch {
          // 不是本合约的事件，跳过
        }
      }
      alreadyMinted.value = true
      phase.value = 'done'
    } catch (e) {
      phase.value = 'error'
      error.value = decodeRevert(e)
    }
  }

  /** 把链上自定义错误翻成人话 */
  function decodeRevert(e: any): string {
    const raw: string | undefined = e?.data ?? e?.info?.error?.data ?? e?.error?.data
    if (typeof raw === 'string') {
      try {
        const c = readContract()
        const parsed = c?.interface.parseError(raw)
        if (parsed) {
          const map: Record<string, string> = {
            AlreadyMinted: '这个地址已经领取过成就了（一人一枚）',
            NotEligible: `还没达标：需要经验 ≥ ${opts.minExp} 或累计步数 ≥ ${opts.minSteps}`,
            LevelExpMismatch: '等级与经验不匹配，刷新页面重试',
            InvalidLevel: '等级数据非法',
            Soulbound: 'SBT 不可转让',
          }
          return map[parsed.name] ?? `链上拒绝：${parsed.name}`
        }
      } catch {
        // 落到下面的通用处理
      }
    }
    return describeError(e)
  }

  function describeError(e: any): string {
    if (e?.code === 'ACTION_REJECTED' || e?.code === 4001) return '你取消了钱包确认'
    if (e?.code === 'INSUFFICIENT_FUNDS') return '钱包余额不足，去 Sepolia 水龙头领一点测试 ETH'
    if (e?.shortMessage) return e.shortMessage
    if (e?.message) return String(e.message).slice(0, 160)
    return '未知错误'
  }

  onBeforeUnmount(() => {
    const eth = injected()
    eth?.removeListener?.('accountsChanged', () => {})
    eth?.removeListener?.('chainChanged', () => {})
  })

  return {
    account,
    chainId,
    phase,
    error,
    txHash,
    tokenId,
    alreadyMinted,
    hasWallet,
    onSepolia,
    contractReady,
    canConnect,
    connect,
    switchToSepolia,
    mint,
    refreshMinted,
  }
}
