/**
 * @fileoverview 模态那一张卡片：**按 `view.kind` 分派**到五个内容渲染器之一（外壳与槽位序在另外两个文件里）
 */

import { Box } from "ink";

import type { RegionProps } from "../types.js";
import { ListWindow } from "./window-list.js";
import { ModelsWindow } from "./window-models.js";
import { ProviderFormWindow } from "./window-provider-form.js";
import { ProviderModelsWindow } from "./window-provider-models.js";
import { SessionsWindow } from "./window-sessions.js";

/**
 * 模态的内容区：一个窗口一次只开一种内容，而七档各有自己的渲染器
 * @description 判据就是 `view.kind` 本身（它与 `@/store` 的 `WindowState.kind` **逐字同名**：
 * 两处各起一个名就得有一张对照表，而零兼容下不许有那张表）。
 */
// ⚠️ `targets` / `users` / `providers` **三档共用一个渲染器** —— 行模型逐字相同、差的只是动作，
// 而分三个渲染器的话「清单那一行怎么画」就有三份实现 ⇒ 于是是**五个**而不是七个。
// ⚠️ **五个渲染器互不 import**、而**分派不收窄**：前者的每一族只有那一档答得出，后者的收窄是**类型**上的事。
export function Window(props: RegionProps): React.JSX.Element {
  const kind = props.view?.kind ?? null;
  switch (kind) {
    case "sessions":
      return <SessionsWindow {...props} />;
    case "targets":
    case "users":
    case "providers":
      return <ListWindow {...props} />;
    case "provider-form":
      return <ProviderFormWindow {...props} />;
    case "provider-models":
      return <ProviderModelsWindow {...props} />;
    case "models":
      return <ModelsWindow {...props} />;
    default:
      return <Box />;
  }
}