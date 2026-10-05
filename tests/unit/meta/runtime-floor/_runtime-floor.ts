import { readEnginesFloor, scanRepo } from "../../../helpers/runtime-floor-scan.js";

/**
 * `tests/unit/meta/runtime-floor/` 三档共用的地板真相与扫描面
 *
 * @description
 * 三个值都是**进程级单例**（`engines` 整个进程只读一次、`scan` 只扫一遍工作树），
 * 共用模块在这里的真实理由不是「少打几个字」而是**三档必须看到同一份命中集合** ——
 * 拆成三份各扫一次的话，「覆盖面那档报出的 N」与「漂移那档判的 N」就可能不一致，
 * 而那种不一致在报告里看不出是哪一边错了。
 * ⚠️ `floor` 在 `engines` 不合格时**故意**是空串（那一层全部落空由 `truth-source` 报出原因），
 * 别改成兜底成某个数 —— 那会让失败信息指向一个不存在的地板。
 * 主题级不变量见 `./AGENTS.md`。
 */

/** 唯一真相源：`package.json` 的 `engines.node` 解析结果 */
export const engines = readEnginesFloor();

/** 全仓扫描面：文本文件清单 + 全部地板声明命中 + 降级面 */
export const scan = scanRepo();

/** 判据要跟的那个地板；`engines` 不合格时为空串（见本文件头） */
export const floor = engines.ok ? `${engines.major}.${engines.minor}.0` : "";