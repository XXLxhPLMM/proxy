/**
 * Cache 抽象 - 优先 Redis，可降级至内存
 * 设计目标：
 * - 业务仅依赖 Cache 接口，不感知底层是 Redis 还是内存
 * - 不强依赖 ioredis，未安装或连接失败时自动 fallback 至 MemoryCache
 * - key 统一 JSON 序列化 value，ttl 单位为秒
 */

export interface CacheOptions {
  /** 默认过期时间（秒），未传则不过期 */
  ttl?: number;
  /** Redis 连接串，有则尝试 Redis，无则直接内存 */
  redisUrl?: string;
  /** key 前缀，用于多租户/环境隔离 */
  prefix?: string;
}

export interface Cache {
  /** 读取，miss 返回 null */
  get<T>(key: string): Promise<T | null>;
  /** 写入，可单独指定 ttl 覆盖默认值 */
  set<T>(key: string, value: T, ttlSec?: number): Promise<void>;
  /** 删除 */
  del(key: string): Promise<void>;
  /** 是否存在（含过期校验） */
  has(key: string): Promise<boolean>;
  /** 清空（内存清 Map，Redis 视 prefix 决定 flushDb 或仅清 fallback） */
  clear(): Promise<void>;
  /** 优雅关闭连接 */
  disconnect?(): Promise<void>;
}

// ---------- Memory 降级实现 ----------
/** 内存条目，含可选过期时间戳 */
type Entry = { value: unknown; expireAt?: number };

export class MemoryCache implements Cache {
  /** 底层存储 */
  private store = new Map<string, Entry>();
  /** 默认 ttl */
  private defaultTtl?: number;
  /** 定期清理定时器 */
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(opts?: CacheOptions) {
    this.defaultTtl = opts?.ttl;
    if (this.defaultTtl) {
      this.sweepTimer = setInterval(() => this.sweep(), 60_000);
      this.sweepTimer.unref();
    }
  }

  /** 判断是否过期 */
  private isExpired(entry: Entry): boolean {
    return entry.expireAt !== undefined && Date.now() > entry.expireAt;
  }

  /** 暂未使用前缀，预留 */
  private namespaced(key: string, prefix?: string): string {
    return prefix ? `${prefix}:${key}` : key;
  }

  async get<T>(key: string): Promise<T | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (this.isExpired(e)) {
      this.store.delete(key);
      return null;
    }
    return e.value as T;
  }

  async set<T>(key: string, value: T, ttlSec?: number): Promise<void> {
    const ttl = ttlSec ?? this.defaultTtl;
    const expireAt = ttl ? Date.now() + ttl * 1000 : undefined;
    this.store.set(key, { value, expireAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const e = this.store.get(key);
    if (!e) return false;
    if (this.isExpired(e)) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  /** 定期删除已过期条目 */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expireAt !== undefined && now > entry.expireAt) {
        this.store.delete(key);
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}

// ---------- Redis 实现（可选依赖） ----------
export class RedisCache implements Cache {
  /** ioredis 客户端实例，类型 any 以避免强依赖类型包 */
  private client: any;
  /** key 前缀 */
  private prefix: string;
  /** 默认 ttl */
  private defaultTtl?: number;
  /** Redis 异常时的内存回退 */
  private fallback: MemoryCache;

  constructor(client: any, opts?: CacheOptions) {
    this.client = client;
    this.prefix = opts?.prefix ?? "";
    this.defaultTtl = opts?.ttl;
    this.fallback = new MemoryCache(opts);
  }

  /** 拼接前缀 */
  private key(key: string): string {
    return this.prefix ? `${this.prefix}:${key}` : key;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(this.key(key));
      if (raw === null || raw === undefined) return null;
      return JSON.parse(raw) as T;
    } catch {
      // Redis 异常降级至内存
      return this.fallback.get<T>(key);
    }
  }

  async set<T>(key: string, value: T, ttlSec?: number): Promise<void> {
    const ttl = ttlSec ?? this.defaultTtl;
    const raw = JSON.stringify(value);
    try {
      if (ttl) await this.client.set(this.key(key), raw, { EX: ttl } as any);
      else await this.client.set(this.key(key), raw);
    } catch {
      await this.fallback.set(key, value, ttl);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(this.key(key));
    } catch {
      await this.fallback.del(key);
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      const exists = await this.client.exists(this.key(key));
      return exists === 1 || exists === true;
    } catch {
      return this.fallback.has(key);
    }
  }

  async clear(): Promise<void> {
    try {
      if (this.prefix) {
        // 带前缀时全库 flush 风险高，仅清回退层
        await this.fallback.clear();
      } else {
        await this.client.flushDb?.();
      }
    } catch {
      await this.fallback.clear();
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.quit?.();
      await this.client.disconnect?.();
    } catch {}
  }
}

// ---------- 工厂：自动降级 ----------
/**
 * 创建缓存实例
 * - 无 redisUrl 直接返回 MemoryCache
 * - 动态 import ioredis，失败或 ping 不通则回退 MemoryCache
 */
export async function createCache(opts?: CacheOptions): Promise<Cache> {
  if (!opts?.redisUrl) return new MemoryCache(opts);

  try {
    // 动态导入，避免未安装 redis 时崩溃
    // @ts-expect-error - optional peer, may not be installed
    const mod: any = await import("ioredis").catch(() => null);
    const Redis = mod?.default ?? mod?.Redis;
    if (!Redis) return new MemoryCache(opts);

    const client = new Redis(opts.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect?.();
    // 探活，失败则视为不可用
    await client.ping?.();
    return new RedisCache(client, opts);
  } catch {
    return new MemoryCache(opts);
  }
}
