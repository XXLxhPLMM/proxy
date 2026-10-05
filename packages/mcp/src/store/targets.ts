/**
 * @fileoverview 「这次要动哪几个 manager」的唯一解法 —— 清单 + 环境 → 一组带凭据的连接
 * @module store/targets
 * @description
 * 每个操作类工具都调 `resolveTargets`。三条规矩，逐条都有代价：
 *
 * ## ① 显式给了 `managers` ⇒ 就是那几条，**不与环境并集**
 * @description 「并集」会让「我只动这两台」变成「我动这两台**加上**当前环境里的全部」，
 * 而那是一次**写**操作打在计划外的机器上。故显式指定是**替换**而不是叠加。
 *
 * ## ② 没给 ⇒ **当前激活的环境**；没有激活 ⇒ **报错给模型**（不静默回退到「全部 manager」）
 * @description 静默回退是最坏的一种体贴：模型以为自己在动「这个环境」，实际动了全部，
 * 而两者在返回结果里长得一模一样（都是一份 per-manager 的结果数组）。宁可让模型重调一次
 * `env_activate`。
 *
 * ## ③ ⚠️ 悬空 id **当场拒**，并且**点名是哪一条**
 * @description 环境清单的写面会验成员存在，但那份 JSON 可以被手改。悬空 id 若放行 →
 * 「这个环境本来只有两台」与「有一台被删了」在返回值里完全一样。模型没有办法区分，
 * 而它正拿着这份返回值决定要不要做写操作。
 */

import { McpError } from "../utils/errors.js";
import type { ManagerConnection } from "../utils/request.js";
import { readEnvs, envByName } from "./envs.js";
import { managerById, managerByRef, readManagers, type ManagerRecord } from "./managers.js";
import { activeEnvName } from "./session.js";

/** 一个待操作的 manager（**带真凭据** —— 故本类型不许进日志、不许进任何返回值） */
export interface Target {
  readonly record: ManagerRecord;
  readonly connection: ManagerConnection;
}

/** 这次为什么选了这些（**逐字给模型看**，让「我为什么动了这几台」有一句人话） */
export interface TargetScope {
  readonly targets: readonly Target[];
  readonly reason: string;
}

/**
 * 解出这次要动哪几个
 * @param refs `managers` 形参的原始值（`undefined` = 没给）；⚠️ 每一项按 **id 或 name** 认
 * @throws {McpError} `local`：没给且没激活 / 名字认不出 / 环境里的 id 悬空
 */
export function resolveTargets(homedir: string, refs: unknown): TargetScope {
  const managers = readManagers(homedir);

  if (refs !== undefined) {
    if (!Array.isArray(refs) || refs.length === 0) {
      throw McpError.local("managers 要么不给，要么给一个非空的 id/name 数组");
    }
    const targets: Target[] = [];
    for (const ref of refs) {
      if (typeof ref !== "string" || ref.trim() === "") {
        throw McpError.local("managers 里每一项都得是 manager 的 id 或 name");
      }
      const record = managerByRef(managers, ref);
      if (record === undefined) {
        throw McpError.local(
          `清单里没有 id 或 name 为 ${ref} 的 manager（manager_list 看现有的那些）`,
        );
      }
      targets.push(toTarget(record));
    }
    return { targets, reason: `指定了 ${targets.length} 个 manager` };
  }

  const name = activeEnvName();
  if (name === null) {
    throw McpError.local(
      "没有激活的环境。先 env_activate 一个环境，或者在这次调用里给 managers 参数指定要动哪几个",
    );
  }
  const env = envByName(readEnvs(homedir), name);
  if (env === undefined) {
    // 激活只存名字、不验存在（见 `@/store/session.js`），故这一档是**可达**的
    throw McpError.local(
      `激活着的环境 ${name} 不在 envs.json 里（它可能被手改过，或这个进程激活后文件被重建了）`,
    );
  }
  if (env.managers.length === 0) {
    throw McpError.local(`环境 ${name} 里一个 manager 都没有（空环境让激活等于什么也不做）`);
  }

  const targets: Target[] = [];
  for (const id of env.managers) {
    const record = managerById(managers, id);
    if (record === undefined) {
      throw McpError.local(
        `环境 ${name} 里的 manager ${id} 不在 managers.json 里（env_list 看这个环境的成员；env_update 改它）`,
      );
    }
    targets.push(toTarget(record));
  }
  return { targets, reason: `当前激活的环境 ${name}` };
}

function toTarget(record: ManagerRecord): Target {
  return {
    record,
    connection: {
      baseUrl: record.baseUrl,
      key: record.key,
      timeoutMs: record.timeoutMs,
    },
  };
}
