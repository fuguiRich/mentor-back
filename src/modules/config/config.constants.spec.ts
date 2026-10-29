import {
  CONFIG_VALUE_TYPES,
  isConfigValueType,
  isValueMatchingType,
  parseNumberValue,
} from './config.constants';

describe('config.constants', () => {
  it('1. 四个类型，顺序固定（OpenAPI 的 enum 与 DB 注释都按它）', () => {
    expect([...CONFIG_VALUE_TYPES]).toEqual([
      'string',
      'number',
      'boolean',
      'json',
    ]);
  });

  it('2. isConfigValueType 只认这四个', () => {
    expect(isConfigValueType('json')).toBe(true);
    expect(isConfigValueType('JSON')).toBe(false);
    expect(isConfigValueType('yaml')).toBe(false);
  });

  it('3. string 什么都收', () => {
    expect(isValueMatchingType('', 'string')).toBe(true);
    expect(isValueMatchingType('{"a":1}', 'string')).toBe(true);
  });

  it('4. number 只收 JSON 数值字面量；Infinity / NaN / 16进制 / 空串都不收', () => {
    expect(isValueMatchingType('42', 'number')).toBe(true);
    expect(isValueMatchingType('-3.14', 'number')).toBe(true);
    expect(isValueMatchingType(' 7 ', 'number')).toBe(true);

    // 这四个是这条规则存在的理由：`typeof Infinity === 'number'`，
    // 存进 VARCHAR 再 parseFloat 读回来照样成功——错误的值以合法的外观流通。
    expect(isValueMatchingType('Infinity', 'number')).toBe(false);
    expect(isValueMatchingType('-Infinity', 'number')).toBe(false);
    expect(isValueMatchingType('NaN', 'number')).toBe(false);
    expect(isValueMatchingType('0x1F', 'number')).toBe(false);
    expect(isValueMatchingType('', 'number')).toBe(false);
    expect(isValueMatchingType('1e3', 'number')).toBe(false);
  });

  it('5b. parseNumberValue 与写入校验同源：空 / 空白是 undefined，不是 0', () => {
    // `Number('')` 与 `Number('  ')` 都是 0。若解析路径单独用 Number()，
    // 一条空配置项会被读成「上限 = 0」而不是「用默认值」——写得进、读不出。
    expect(parseNumberValue('')).toBeUndefined();
    expect(parseNumberValue('   ')).toBeUndefined();
    expect(parseNumberValue('0')).toBe(0);
    expect(parseNumberValue('42')).toBe(42);
    expect(parseNumberValue('1e3')).toBeUndefined();
    expect(parseNumberValue('Infinity')).toBeUndefined();
  });

  it('5. boolean 只收字面量 true / false，不收 1 / 0 / yes', () => {
    // 「宽松一点」会让 getBoolean 的 `row.value === 'true'` 永远读出 false，
    // 一个写得进、读不出的配置项比报错难查得多。
    expect(isValueMatchingType('true', 'boolean')).toBe(true);
    expect(isValueMatchingType('false', 'boolean')).toBe(true);
    expect(isValueMatchingType('1', 'boolean')).toBe(false);
    expect(isValueMatchingType('0', 'boolean')).toBe(false);
    expect(isValueMatchingType('yes', 'boolean')).toBe(false);
    expect(isValueMatchingType('True', 'boolean')).toBe(false);
  });

  it('6. json 要能 JSON.parse 通过；标量也可以（JSON 本来就含标量）', () => {
    expect(isValueMatchingType('{"a":1}', 'json')).toBe(true);
    expect(isValueMatchingType('[1,2]', 'json')).toBe(true);
    expect(isValueMatchingType('null', 'json')).toBe(true);
    expect(isValueMatchingType('{a:1}', 'json')).toBe(false);
    expect(isValueMatchingType('', 'json')).toBe(false);
  });
});
