/**
 * uni-app 全局 API 的最小类型声明
 *
 * 只声明本工程实际用到的成员，签名刻意放宽成 any —— 目的是让
 * `tsc --noEmit` 能检查我们的逻辑与类型，而不必引入整个 uni-app SDK
 * （真机上由 HBuilderX 提供完整实现）。
 *
 * 方法名都按官方文档写全，拼错会被 tsc 抓到。
 */

interface UniStorageApi {
  getStorageSync(key: string): unknown
  setStorageSync(key: string, value: unknown): void
  removeStorageSync(key: string): void
}

interface UniBleApi {
  openBluetoothAdapter(options?: any): void
  closeBluetoothAdapter(options?: any): void
  startBluetoothDevicesDiscovery(options?: any): void
  stopBluetoothDevicesDiscovery(options?: any): void
  onBluetoothDeviceFound(callback: (res: any) => void): void
  createBLEConnection(options?: any): void
  closeBLEConnection(options?: any): void
  getBLEDeviceServices(options?: any): void
  getBLEDeviceCharacteristics(options?: any): void
  notifyBLECharacteristicValueChange(options?: any): void
  onBLECharacteristicValueChange(callback: (res: any) => void): void
  onBLEConnectionStateChange(callback: (res: any) => void): void
  setBLEMTU(options?: any): void
}

interface UniNetworkApi {
  onNetworkStatusChange(callback: (res: any) => void): void
  offNetworkStatusChange(callback: (res: any) => void): void
}

interface UniRequestApi {
  request(options?: any): void
}

declare const uni: UniStorageApi & UniBleApi & UniNetworkApi & UniRequestApi
