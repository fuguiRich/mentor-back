/**
 * 系统配置的值类型。
 *
 * 存成字符串列（`value` VARCHAR(500)）而不是 JSON 列：配置项里绝大多数是
 * 一个开关或一个数字，JSON 列会让「读一个布尔」变成 `JSON_EXTRACT` + 解析，
 * 而写入方还要自己决定包不包引号。`valueType` 负责说清楚 `value` 怎么解析。
 */
export const CONFIG_VALUE_TYPES = [
  'string',
  'number',
  'boolean',
  'json',
] as const;

export type ConfigValueType = (typeof CONFIG_VALUE_TYPES)[number];

/** 供 DTO 的 @IsIn 与 OpenAPI 的 enum 用 */
export const CONFIG_VALUE_TYPE_VALUES: readonly string[] = CONFIG_VALUE_TYPES;

export function isConfigValueType(value: string): value is ConfigValueType {
  return (CONFIG_VALUE_TYPES as readonly string[]).includes(value);
}

/**
 * 把 `value` 按 number 规则解析出来；不合法返回 undefined。
 *
 * 与 `isValueMatchingType` 的 number 分支**同源**——写入校验与读出解析各写一遍，
 * 迟早分叉：那一版的洞是 `Number('')` 是 0、`Number('  ')` 也是 0，
 * 于是一条空配置项被读成「限流上限 = 0」，而不是「用默认值」。
 *
 * 挡 Infinity / NaN / 0x1F / 1e3：它们都能被 `Number()` 接受，
 * 但都不是 JSON 数值字面量，存进 VARCHAR 再读回来照样成功——
 * 错误的值以合法的外观流通。
 */
export function parseNumberValue(value: string): number | undefined {
  const text = value.trim();
  if (text === '' || !/^-?\d+(\.\d+)?$/.test(text)) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 校验 `value` 与 `valueType` 是否相符；不符返回 false。
 */
export function isValueMatchingType(
  value: string,
  valueType: ConfigValueType,
): boolean {
  switch (valueType) {
    case 'string':
      return true;
    case 'number':
      return parseNumberValue(value) !== undefined;
    case 'boolean':
      return value === 'true' || value === 'false';
    case 'json':
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
  }
}
