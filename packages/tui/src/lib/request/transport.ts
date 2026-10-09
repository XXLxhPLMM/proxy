/**
 * @fileoverview 一次控制面请求的**形状**：`ManagerTarget` / `Method` / `RequestSpec` / `Response` 四个纯类型
 * @module lib/request/transport
 * @description 发送工具里能收敛进 `@/lib` 的只有这一份（零 IO、零 zod）。⚠️ 拨号与收窄住 `@/api/transport/send.js`。
 */

/** 一条台账记录里够发一次请求的那三样（⚠️ **凭据就在这里**，故本类型不许进日志 / 不许进错误文案） */
export interface ManagerTarget {
  /** 控制面基址；⚠️ 出门前**再过一次**归一（见 `@/api/transport/send.js:sendDecoded`） */
  readonly baseUrl: string;
  /** `MANAGER_TOKEN`；⚠️ 等价于主机上的 root shell */
  readonly token: string;
  readonly timeoutMs: number;
}

/** HTTP 动词（只用控制面用到的四种；表外的动词在服务端一律 405） */
export type Method = "GET" | "POST" | "PUT" | "DELETE";

/** 一次请求的规格（`@/api` 里每个端点函数发出去的那一份） */
export interface RequestSpec {
  /**
   * ⚠️ **必写在 `path` 之前** —— 仓库根那道端点契约护栏（`tests/unit/manager/tui-contract.test.ts`）
   * 正是按这一排版形状从源码文本现取 `(method, path)`，反着排它会报「少了一条端点」。
   */
  readonly method: Method;
  /** 路径；含 `:username` 段的是**模板**（代入在 `@/lib/request/http.js:endpointPath`） */
  readonly path: string;
  /** ⚠️ **有它才带 `Content-Type`**：无 body 的请求带了那个头会被读成空 patch 之类的怪事 */
  readonly body?: unknown;
}

/**
 * 线上给的响应体，**本包一个字都不改**
 * @description ⚠️ `z.infer` 推出来的是**可变**类型，而响应体是**对面给的快照**——改它就是改「控制面说了什么」。
 * 由这一个映射保住「响应体只读」这条纪律。函数类型原样穿过（判据面不需要把它变成一个没有 `apply` 的对象）。
 */
export type Response<T> =
  T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer U)[] ? readonly Response<U>[]
  : T extends object ? { readonly [K in keyof T]: Response<T[K]> }
  : T;
