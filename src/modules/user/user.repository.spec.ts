import { buildUserListWhere } from './user.repository';

/**
 * 这里钉的是 where 的**形状**，不是查询结果。
 *
 * 理由：deptId 与 scope 的部门集合、userIds 与 scope 的 selfId 都会落到同一个
 * where 键上。若把它们用对象展开合并，后写的那个会静默吃掉先写的那个，
 * 而「查不出任何人」和「这人的权限就是这么窄」在列表结果上一模一样——
 * 只有断言 where 的形状能把这两种情形分开。这也是本文件唯一存在的理由。
 */
describe('buildUserListWhere', () => {
  it('没有任何条件 → 空 where（不塞空的 AND）', () => {
    expect(buildUserListWhere({})).toEqual({});
  });

  it('deptId 与 scope.deptIds 会落到同一个键上，必须两条都留着（AND 而不是覆盖）', () => {
    const where = buildUserListWhere({
      deptId: 42n,
      scope: { kind: 'depts', deptIds: [42n, 43n] },
    });

    expect(where).toEqual({
      AND: [{ deptId: 42n }, { deptId: { in: [42n, 43n] } }],
    });
  });

  it('userIds 与 scope.self 都作用在 id 上，必须两条都留着', () => {
    const where = buildUserListWhere({
      userIds: [5n, 6n],
      scope: { kind: 'self', userId: 5n },
    });

    expect(where).toEqual({
      AND: [{ id: { in: [5n, 6n] } }, { id: 5n }],
    });
  });

  it('scope.kind=all → 不加行级约束，其余条件照常生效', () => {
    const where = buildUserListWhere({
      status: 1,
      scope: { kind: 'all' },
    });

    expect(where).toEqual({ AND: [{ status: 1 }] });
  });

  it('scope.kind=depts 且 deptIds 为空 → in: []（一行都看不见，fail-closed）', () => {
    // 空数组**不是**「不限」。把它当成不限，等于把全校数据交给一次配置失误。
    const emptyScope = buildUserListWhere({
      scope: { kind: 'depts', deptIds: [] },
    });
    expect(emptyScope).toEqual({ AND: [{ deptId: { in: [] } }] });
  });

  it('self 在 sys_user 译成 id = userId（不是 created_by）', () => {
    const where = buildUserListWhere({ scope: { kind: 'self', userId: 7n } });
    expect(where).toEqual({ AND: [{ id: 7n }] });
  });

  it('模糊条件与精确条件同时给 → 都进 AND，互不覆盖', () => {
    expect(
      buildUserListWhere({
        username: 'zhang',
        realName: '张',
        employeeNo: 'E1',
        deptId: 1n,
        status: 1,
      }),
    ).toEqual({
      AND: [
        { username: { contains: 'zhang' } },
        { realName: { contains: '张' } },
        { employeeNo: { contains: 'E1' } },
        { deptId: 1n },
        { status: 1 },
      ],
    });
  });
});
