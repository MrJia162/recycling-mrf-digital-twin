export type ColorTarget =
  | "floor"
  | "wall"
  | "steel"
  | "silo"
  | "conveyor"
  | "belt"
  | "sorter"
  | "delabel"
  | "screw"
  | "baler"
  | "platform"
  | "robot"
  | "weighing"
  | "pipe"
  | "partition"
  | "auxiliary";

export type ColorScheme = Record<ColorTarget, string>;
export type ColorOverrides = Partial<ColorScheme>;

export interface PartPickInfo {
  key: string;
  deviceId: string;
  materialName: string;
  color: string;
}

export type PartColors = Record<string, string>;

export function partColorKey(deviceId: string, materialName: string): string {
  return `${deviceId}:${materialName}`;
}

export const DEFAULT_PART_COLORS: PartColors = {
  [partColorKey("E12", "mat_14")]: "#3768a2",
  [partColorKey("E17", "mat_14")]: "#3768a2",
  [partColorKey("E18", "mat_14")]: "#3768a2",
  [partColorKey("E13", "mat_19")]: "#3768a2",
  [partColorKey("E06", "mat_13")]: "#3768a2",
  [partColorKey("E06", "mat_0")]: "#3768a2",
  [partColorKey("E06", "mat_15")]: "#414649",
  [partColorKey("E15", "mat_13")]: "#3768a2",
  [partColorKey("E09", "mat_13")]: "#3768a2",
  [partColorKey("E09", "mat_0")]: "#3768a2",
  [partColorKey("E07", "mat_17")]: "#414649",
  [partColorKey("E09", "mat_15")]: "#414649",
  [partColorKey("E16", "mat_74")]: "#414649",
  [partColorKey("E14", "mat_14")]: "#3b3b3f",
  [partColorKey("E14", "mat_13")]: "#73787d",
  [partColorKey("E12", "mat_0")]: "#e5d315",
  [partColorKey("E13", "mat_25")]: "#e5d315",
  [partColorKey("E13", "mat_10")]: "#d06016",
  [partColorKey("E30", "mat_0")]: "#3768a2",
  [partColorKey("E10", "mat_14")]: "#3768a2",
  [partColorKey("E10", "mat_13")]: "#3768a2",
  [partColorKey("E10", "mat_0")]: "#3768a2",
  [partColorKey("E08", "mat_0")]: "#3768a2",
  [partColorKey("E11", "mat_0")]: "#3768a2",
  [partColorKey("E07", "mat_0")]: "#3768a2",
};

export interface ColorGroup {
  key: ColorTarget;
  label: string;
  hint: string;
}

export const DEFAULT_COLORS: ColorScheme = {
  floor: "#91918d",
  wall: "#919597",
  steel: "#b9c1c4",
  silo: "#303136",
  conveyor: "#40464a",
  belt: "#43494c",
  sorter: "#7f8a90",
  delabel: "#3f6f8f",
  screw: "#5a6a72",
  baler: "#1c3f63",
  platform: "#5d7b8c",
  robot: "#6c8794",
  weighing: "#6f8a96",
  pipe: "#b9bfc4",
  partition: "#5f7c8a",
  auxiliary: "#66767e",
};

export const COLOR_GROUPS: ColorGroup[] = [
  { key: "floor", label: "厂房地板", hint: "地面与地坪" },
  { key: "wall", label: "厂房墙面", hint: "彩钢外墙" },
  { key: "steel", label: "钢结构", hint: "檩条与屋架" },
  { key: "silo", label: "料仓", hint: "E02–E05" },
  { key: "conveyor", label: "输送设备", hint: "E06–E10 · E16 · 过渡段" },
  { key: "belt", label: "输送皮带", hint: "皮带面层" },
  { key: "sorter", label: "分选机", hint: "E17 · E18" },
  { key: "delabel", label: "脱标机", hint: "E12" },
  { key: "screw", label: "螺旋上料机", hint: "E11" },
  { key: "baler", label: "打包机", hint: "E13" },
  { key: "platform", label: "人工分拣平台", hint: "E14" },
  { key: "robot", label: "并联机械手", hint: "E15" },
  { key: "weighing", label: "称重台", hint: "E25" },
  { key: "pipe", label: "管道", hint: "E26–E33" },
  { key: "partition", label: "隔断", hint: "E19–E24" },
  { key: "auxiliary", label: "辅助设备", hint: "其它模块" },
];
