/**
 * 「这个人是不是导师」的唯一判定口径。
 *
 * 同步源会把所有教师标成 `teacher`，而不是 `internalMentor`：教师是身份，
 * 导师是业务资格。但现有档案 / 申请 / 材料 / 检索 / 统计都按 `internalMentor`
 * 判身份，所以这里集中一份白名单，避免每个调用点各写一遍
 * `personType === 'internalMentor' || ...` 而漏掉 `teacher`。
 */
export const MENTOR_PERSON_TYPES = [
  'internalMentor',
  'externalMentor',
  'teacher',
] as const;

export function isMentorPersonType(value: string): boolean {
  return (MENTOR_PERSON_TYPES as readonly string[]).includes(value);
}

/**
 * `SyncPerson.personType` → 响应的 `mentorType`。
 * 只有 `externalMentor` 算校外；`teacher` 与 `internalMentor` 都算校内。
 */
export function deriveMentorType(value: string): 'internal' | 'external' {
  return value === 'externalMentor' ? 'external' : 'internal';
}
