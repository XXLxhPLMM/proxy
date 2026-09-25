/**
 * PresetService - 预设目录查询端口
 *
 * 服务只读取 ConfigService 已加载的 preset 字段并查询 presets catalog；
 * 不读环境变量、不写 store，也不负责动态加载 Cordis 插件。
 */
import {
  PRESETS,
  resolvePreset,
  type PresetDefinition,
  type PresetName,
} from "@/config/presets.js";
import type { ConfigService } from "./config-service.js";

export interface PresetService {
  /** 列出全部预设定义。 */
  list(): readonly PresetDefinition[];

  /** 返回当前启用的预设；未启用时为 undefined。 */
  active(): PresetDefinition | undefined;

  /** 不传名称时读取当前预设；传名称时按 catalog 查询，未知名称沿用配置错误。 */
  get(): PresetDefinition | undefined;
  get(name: PresetName): PresetDefinition;
}

/** 创建只做 catalog 与 ConfigService 委托的预设服务。 */
export function createPresetService(config: Pick<ConfigService, "get">): PresetService {
  function getPreset(): PresetDefinition | undefined;
  function getPreset(name: PresetName): PresetDefinition;
  function getPreset(name?: PresetName): PresetDefinition | undefined {
    const activeName = name ?? config.get("preset");
    return activeName === "" ? undefined : resolvePreset(activeName);
  }

  return {
    list(): readonly PresetDefinition[] {
      return Object.values(PRESETS);
    },
    active(): PresetDefinition | undefined {
      return getPreset();
    },
    get: getPreset,
  };
}
