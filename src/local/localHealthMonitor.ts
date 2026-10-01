/**
 * 基础设施层：带 TTL 缓存的本地服务健康探测。
 *
 * `LocalModelClient.isAvailable()` 每次都会发起一次 HTTP 探测；路由决策发生在
 * 每次请求前，若每次都实时探测会拖慢交互。本类缓存上一次探测结果，并在缓存过期时
 * 由编排层按需刷新。
 */

import { LocalModelClient } from './localModelClient';

export const DEFAULT_HEALTH_TTL_MS = 15_000;

export class LocalHealthMonitor {
  private available = false;
  private checkedAt = 0;

  constructor(
    private readonly client: LocalModelClient,
    private readonly ttlMs: number = DEFAULT_HEALTH_TTL_MS
  ) {}

  /** 上一次探测的缓存结果；从未探测过时为 false。 */
  snapshot(): boolean {
    return this.available;
  }

  /** 缓存是否已过期（从未探测过视为过期）。 */
  isStale(now: number = Date.now()): boolean {
    return now - this.checkedAt >= this.ttlMs;
  }

  /** 实时探测并更新缓存；失败（不可用）也视为一次有效探测时间点。 */
  async refresh(): Promise<boolean> {
    this.available = await this.client.isAvailable();
    this.checkedAt = Date.now();
    return this.available;
  }
}