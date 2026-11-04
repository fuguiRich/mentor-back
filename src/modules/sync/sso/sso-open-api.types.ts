/** SSO 开放接口的响应形状（只列本系统用到的字段，其余原样忽略） */

export interface SsoOrgDept {
  deptId: string;
  parentId: string;
  deptName: string;
  orderNum?: number;
  /** 叶子可能是 [] 或 ""，判断统一用 `!children?.length` */
  children?: SsoOrgDept[] | '';
}

export interface SsoTeacher {
  workId: string;
  name: string;
  organization: string;
}

export interface SsoStudent {
  studentId: string;
  name: string;
  organization: string;
}

export interface SsoClass {
  class_name: string;
  college_name: string;
  major_name?: string;
}

export interface SsoEduCollege {
  college_name: string;
  majors?: unknown[];
}

export interface SsoPage<T> {
  code: number;
  msg?: string;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  items: T[];
}
