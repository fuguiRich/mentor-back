import type { SsoOpenApiClient } from './sso-open-api.client';
import { SsoSyncSource } from './sso-sync.source';

function makeSource(
  overrides: Partial<Record<keyof SsoOpenApiClient, unknown>>,
): SsoSyncSource {
  const client = {
    getOrgDepartments: () => [],
    getTeachers: () => [],
    getStudents: () => [],
    getClasses: () => [],
    getEduOrg: () => [],
    ...overrides,
  } as unknown as SsoOpenApiClient;
  return new SsoSyncSource(client);
}

describe('SsoSyncSource', () => {
  it('组织树摊平：parentId=0 → parentCode=null，code 加 sso: 前缀', async () => {
    const source = makeSource({
      getOrgDepartments: () => [
        {
          deptId: '1',
          parentId: '0',
          deptName: '长沙医学院',
          children: [
            {
              deptId: '10',
              parentId: '1',
              deptName: '计算机学院',
              children: [],
            },
          ],
        },
      ],
    });

    const rows = await source.fetchOrgUnits(null);

    expect(rows).toEqual([
      { code: 'sso:1', name: '长沙医学院', parentCode: null, kind: 'root' },
      {
        code: 'sso:10',
        name: '计算机学院',
        parentCode: 'sso:1',
        kind: 'college',
      },
    ]);
  });

  it('教师按部门名映射到 sso:code；学生按班级→学院映射', async () => {
    const source = makeSource({
      getOrgDepartments: () => [
        {
          deptId: '1',
          parentId: '0',
          deptName: '学校',
          children: [
            {
              deptId: '10',
              parentId: '1',
              deptName: '计算机学院',
              children: [],
            },
          ],
        },
      ],
      getTeachers: () => [
        { workId: 'T1', name: '张三', organization: '计算机学院' },
      ],
      getStudents: () => [
        { studentId: 'S1', name: '李四', organization: '软工2301' },
      ],
      getClasses: () => [
        {
          class_name: '软工2301',
          college_name: '计算机学院',
          major_name: '软件工程',
        },
      ],
    });

    const persons = await source.fetchPersons(null);

    expect(persons).toEqual([
      expect.objectContaining({
        login: 'T1',
        personType: 'teacher',
        orgUnitCode: 'sso:10',
      }),
      expect.objectContaining({
        login: 'S1',
        personType: 'student',
        orgUnitCode: 'sso:10',
        className: '软工2301',
        major: '软件工程',
      }),
    ]);
  });

  it('映射不到 → unresolved:...，交给 SyncService 记 org_not_found', async () => {
    const source = makeSource({
      getOrgDepartments: () => [],
      getTeachers: () => [
        { workId: 'T2', name: '王五', organization: '不存在学院' },
      ],
      getStudents: () => [],
      getClasses: () => [],
    });

    const persons = await source.fetchPersons(null);

    expect(persons[0].orgUnitCode).toBe('unresolved:teacher:不存在学院');
  });
});
