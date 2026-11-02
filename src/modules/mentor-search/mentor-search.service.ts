import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-code';
import { BusinessException } from '../../common/errors/business.exception';
import {
  QueryMentorDto,
  MentorSearchPageResponseDto,
} from './dto/query-mentor.dto';
import { MentorSearchDetailResponseDto } from './dto/mentor-search-response.dto';
import { MentorSearchMapper } from './mentor-search.mapper';
import {
  MentorSearchRepository,
  type MentorSearchParams,
} from './mentor-search.repository';

/**
 * 导师检索（Task 22，学生侧）。
 *
 * **只读、跨院**：没有身份链，也不按调用者的角色 `data_scope` 收窄——检索页
 * 本来就是全校导师的目录，学生 / 导师 / 管理员看到的是同一份结果。天花板
 * `@DataScope('all')` 只声明「上限是全部」，服务端不需要 `DataScopeService`
 * （没有行级归属要判）。「谁能调」由权限码 `mentor:search` 决定。
 *
 * 恒有的两道门（都在 repository 的 where 里）：`MentorProfile.status = 2 APPROVED`
 * 与「人员未离场」（`SyncPerson.deletedAt IS NULL`）。未生效 / 已软删 / 人员已离场 /
 * 不存在的档案在列表与详情里都看不见。
 */
@Injectable()
export class MentorSearchService {
  constructor(
    private readonly repository: MentorSearchRepository,
    private readonly mapper: MentorSearchMapper,
  ) {}

  /** `GET /mentors`：分页 + 六个筛选条件（AND），结构 { list, total, page, pageSize } */
  async findPage(query: QueryMentorDto): Promise<MentorSearchPageResponseDto> {
    const { rows, total } = await this.repository.findPage(
      toSearchParams(query),
    );

    return {
      list: rows.map((row) => this.mapper.toItem(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * `GET /mentors/:id`：`:id` 是 `MentorProfile.id`。
   * 不存在 / 未生效 / 已软删**同判** 404 / 31102——学生侧不需要区分
   * 「还没批」与「没有这个人」。
   */
  async findOne(id: bigint): Promise<MentorSearchDetailResponseDto> {
    const row = await this.repository.findApprovedById(id);
    if (row === null) {
      throw new BusinessException(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.mapper.toDetail(row);
  }
}

/**
 * query DTO → repository 参数：`deptId` 的 BIGINT 字符串在这里转成 bigint
 * （DTO 已用 `@IsBigIntId` 校验，`BigInt()` 不会抛）。其余字段原样透传；
 * `undefined` 才是「没传」，空字符串不是。
 */
function toSearchParams(query: QueryMentorDto): MentorSearchParams {
  return {
    ...(query.name === undefined ? {} : { name: query.name }),
    ...(query.mentorType === undefined ? {} : { mentorType: query.mentorType }),
    ...(query.researchField === undefined
      ? {}
      : { researchField: query.researchField }),
    ...(query.professionalTitle === undefined
      ? {}
      : { professionalTitle: query.professionalTitle }),
    ...(query.weekday === undefined ? {} : { weekday: query.weekday }),
    ...(query.deptId === undefined ? {} : { deptId: BigInt(query.deptId) }),
    ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
    page: query.page,
    pageSize: query.pageSize,
  };
}
