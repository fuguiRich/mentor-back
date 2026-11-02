import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { DataScope } from '../../common/decorators/data-scope.decorator';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample } from '../../common/dto/err-example';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import {
  QueryMentorDto,
  MentorSearchPageResponseDto,
  MentorSearchParamDto,
} from './dto/query-mentor.dto';
import { MentorSearchDetailResponseDto } from './dto/mentor-search-response.dto';
import { MentorSearchService } from './mentor-search.service';

/**
 * 导师检索（Task 22，学生侧）——**恰好 2 条路由**，全部 `mentor:search` +
 * `@DataScope('all')`。
 *
 * 只读、跨院：检索页是全校导师目录，不按调用者的角色范围收窄；学生 / 导师 /
 * 管理员只要拿到权限码就都能调。**只返回 `status = 2 APPROVED` 的导师**。
 * 本模块没有写路径——不建预约、不改档案、不碰时段。
 */
@ApiTags('导师检索')
@Controller('mentors')
export class MentorSearchController {
  constructor(private readonly mentorSearchService: MentorSearchService) {}

  @Get()
  @RequirePermission('mentor:search')
  @DataScope('all')
  @ApiOperation({
    summary: '检索导师（学生侧）',
    description:
      '只返回 `MentorProfile.status = 2 APPROVED` 的导师；未生效 / 已软删的档案查不到，' +
      '已离场（`SyncPerson` 软删）的导师同样不出现。' +
      '查询参数**全部可选、彼此 AND**（一个都不传 = 全部已生效导师）：' +
      '`name` 模糊匹配导师姓名（`SyncPerson.realName`）；' +
      '`mentorType` 取 `internal` / `external`（由 `SyncPerson.personType` 显式相等推导：' +
      '`internalMentor` / `externalMentor`，其余取值 → **400 / 10001**）；' +
      '`researchField` 是 `researchFields`（JSON 数组）的**精确项匹配**——传「人工」不命中' +
      '「人工智能」；`professionalTitle` 模糊匹配职称 / 资质（R28）；' +
      '`weekday` 取 1 周一 … 7 周日，只出**该周几有 `status=1` 且未软删时段**的导师' +
      '（越界 → **400 / 10001**）；`deptId` 精确匹配 `SyncPerson.orgUnitId → ' +
      'SyncOrgUnit.deptId` 的学院投影；' +
      '`keyword` 是通用搜索框，只匹配姓名 / 个人简介——**不匹配指导方向**' +
      '（R29：方向请用 `researchField` 精确筛选，同一字段不留两套口径）。' +
      '`page` 默认 1；`pageSize` 默认 20、**上限 100**（101 → 400 / 10001）。' +
      '列表项为 `id` / `name` / `mentorType` / `deptName` / `professionalTitle` / ' +
      '`researchFields` / `summary`——**不含任何学生字段**（R27：学号 / 学院 / 专业 / ' +
      '行政班级属于预约详情与审核界面，不属于导师检索页）。' +
      '权限码 `mentor:search`；数据范围天花板 **`all`**（检索本就跨院）。',
  })
  @ApiOkResponse({
    type: MentorSearchPageResponseDto,
    description:
      '检索成功，返回 `{ list, total, page, pageSize }`（档案 ID 升序）',
  })
  @ApiForbiddenResponse({
    description: '缺权限码 `mentor:search`（403 / 10003）',
    schema: {
      example: errExample(
        ErrorCode.FORBIDDEN,
        '无权限访问：缺少 mentor:search',
      ),
    },
  })
  async list(
    @Query() query: QueryMentorDto,
  ): Promise<MentorSearchPageResponseDto> {
    return this.mentorSearchService.findPage(query);
  }

  @Get(':id')
  @RequirePermission('mentor:search')
  @DataScope('all')
  @ApiOperation({
    summary: '导师详情（学生侧）',
    description:
      '`:id` 是 `MentorProfile.id`（BIGINT 对外字符串）。' +
      '**只返回已生效（status = 2 APPROVED）的档案**：不存在 / 未生效 / 已软删 / ' +
      '人员已离场一律 **404 / 31102**（学生侧不区分「还没批」与「没有这个人」）。' +
      '详情 = 列表项的全部字段 + `researchAchievements` / `guidanceExperience` / ' +
      '`affiliateOrg` / `socialRoles` / `mobile`（§2.1「查看内容」与 §3.1 的联系电话）。' +
      '**同样不含任何学生字段**（R27）。' +
      '权限码 `mentor:search`；数据范围天花板 **`all`**。',
  })
  @ApiOkResponse({
    type: MentorSearchDetailResponseDto,
    description: '查询成功，返回导师详情（id 为 BIGINT 字符串）',
  })
  @ApiNotFoundResponse({
    description: '导师不存在 / 未生效 / 已软删 / 人员已离场（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 `mentor:search`（403 / 10003）',
    schema: {
      example: errExample(
        ErrorCode.FORBIDDEN,
        '无权限访问：缺少 mentor:search',
      ),
    },
  })
  async findOne(
    @Param() params: MentorSearchParamDto,
  ): Promise<MentorSearchDetailResponseDto> {
    return this.mentorSearchService.findOne(BigInt(params.id));
  }
}
