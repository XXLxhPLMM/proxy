/**
 * @fileoverview 单条调用缓存：把一元纯函数包成「记住上一次入参 → 结果」的版本
 * @module ink-ui/utils/memo
 * @description
 * 给「同一 tick 里多个调用方拿着**同一个**入参重复求值」用：第一个真算，其余按 `===` 命中。
 * 典型场合：ink 把一条输入广播给它的每个 `useInput` 订阅者，N 个订阅者手里是同一根字符串。
 * ⚠️ 本包当前**没有接线者**：它曾接在 `hooks/mouse/protocol.ts` 的解析路径上，因收益为负而摘掉
 * （单消费者时命中率恒为 0，却让每个事件都背上「命中交回同一引用、消费方只读」的契约）。
 *
 * ⚠️ **只在 `compute` 是纯函数时才算等价替换**：同一入参必须恒等同一结果；读时钟、读文件、
 * 带累积副作用的函数不许包。
 * ⚠️ **命中交回的是同一个对象引用**（不是副本）：消费方一律当只读用。
 * ⚠️ 缓存不限期持有 key（模块级存活），超长 key 要挡住得由调用方自己判长度。
 *
 * 纯机制层：零 IO、零 React、零依赖（规约见 `@/ink-ui/utils/index.js`）。
 */

/**
 * @param compute 纯函数：同一入参恒等同一结果
 * @returns 同签名函数；入参 `===` 上一次时直接返还上次结果
 */
export function createLastCallMemo<K, V>(compute: (key: K) => V): (key: K) => V {
  // 用对象装而不是两个 `let`：省掉「未填充」标志位，也不会有 `V | undefined` 的断言
  let cache: { key: K; value: V } | null = null;
  return (key: K): V => {
    if (cache !== null && cache.key === key) return cache.value;
    const value = compute(key);
    cache = { key, value };
    return value;
  };
}
