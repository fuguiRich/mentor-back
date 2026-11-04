import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DataScope } from '../../common/decorators/data-scope.decorator';
import type { RequestUser } from '../../common/context/request-context';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample, errExamples } from '../../common/dto/err-example';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { MentorService, type AdminUpdateRequestMeta } from './mentor.service';
import {
  MentorProfileResponseDto,
  UpdateMentorProfileDto,
} from './dto/mentor-profile.dto';
import { MentorProfileParamDto } from './dto/mentor-profile-param.dto';

/**
 * 导师专业档案（Task 11 + 12 + 18）——**恰好 3 条路由**。
 *
 * `MentorProfile` 是「我本人的专业档案」，一人一行、挂在 `SyncPerson` 上：
 * 「我的」两条没有按 id 的入参（只能改自己的），首次建档走 `PUT`（upsert）。
 * 第三条 `PUT /mentor/profiles/:id` 是 Task 18 给双创学院管理员的**后台改档**
 * 口子——必须留痕（落库与 `SysOpLog` 同一次事务），权限码 + 数据范围双重把关。
 */
@ApiTags('导师档案')
@Controller('mentor')
export class MentorController {
  constructor(private readonly mentorService: MentorService) {}

  @Get('profile')
  @RequirePermission('mentor:profile')
  @DataScope('self')
  @ApiOperation({
    summary: '查询我的导师专业档案',
    description:
      '返回本人的专业档案（一人一行，挂在 SyncPerson 上；身份靠 ' +
      'SysUser.username ↔ SyncPerson.login 的自然键解析，不收任何 id 入参）。' +
      '**全状态可读**——R55 只关写不关读。未建档返回 **404 / 31102**' +
      '（GET 不做自动建行，读接口不许有写副作用）。' +
      '调用者不是导师（personType ∉ {internalMentor, externalMentor}，含学生）' +
      '返回 **403 / 10003**——学生永远不会有导师档案，给 404 会让人以为再试一次就有了。' +
      'mentorType 不落列，由 SyncPerson.personType 推导（internalMentor/teacher→internal，' +
      'externalMentor→external）。',
  })
  @ApiOkResponse({
    type: MentorProfileResponseDto,
    description: '查询成功，返回导师专业档案（id / personId 为 BIGINT 字符串）',
  })
  @ApiNotFoundResponse({
    description: '未建档（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '调用者不是导师（403 / 10003）',
    schema: {
      example: errExample(
        ErrorCode.FORBIDDEN,
        '只有导师（internalMentor / externalMentor / teacher）有专业档案',
      ),
    },
  })
  async findMyProfile(
    @CurrentUser() caller: RequestUser,
  ): Promise<MentorProfileResponseDto> {
    return this.mentorService.findMyProfile(caller);
  }

  @Put('profile')
  // brief 写的是 `mentor:profile:update`，但既有契约 PERMISSION_CODE_PATTERN
  // （恰好一个冒号）拒收两冒号码——POST /permissions 回 400，权限点根本建不出来，
  // 非超管永远拿不到写口。最小改动：第二个冒号改中划线（偏差已申报）。
  @RequirePermission('mentor:profile-update')
  @DataScope('self')
  @ApiOperation({
    summary: '维护我的导师专业档案（草稿）',
    description:
      '**upsert**：没有行就建（status = 0 DRAFT），有行就更新草稿列——' +
      '「只能改自己的」不靠入参，靠调用者身份解析（SysUser.username ↔ ' +
      'SyncPerson.login → personId），路径与请求体里都没有 id。' +
      '**只认 7 个字段**：researchFields / summary / achievements / ' +
      'guidanceExperience / affiliateOrg / socialRoles / professionalTitle；' +
      'id / personId / ' +
      'mentorType / status / 任何未知字段一律 **400 / 10001**（全局 ' +
      'forbidNonWhitelisted）。字段约束（ERR-06 逐字段）：researchFields 自由文本' +
      '数组（Ruling #13 不做字典），每项 ≤ 30 字符、≤ 5 项、允许 []；' +
      'summary / achievements / guidanceExperience 各 ≤ 2000 字符（R48）；' +
      'affiliateOrg / socialRoles 各 ≤ 100 字符，且**仅校外导师保留**——校内导师' +
      '传了不报错，落库时置 NULL（R49）；professionalTitle ≤ 100 字符，' +
      '**内校 / 外校都填**（R28，不置 NULL）。' +
      '**R55 status 门**：status ∈ {0 DRAFT, 3 REJECTED} 才可写；' +
      '1 PENDING / 2 APPROVED / 4 FROZEN / 5 REMOVED 一律 **409 / 31103**' +
      '（已生效的行直接改就把审核流架空了，改字段走 Task 15 的信息修改申请）。' +
      'status 由审核流驱动，接口不得直接改。',
  })
  @ApiOkResponse({
    type: MentorProfileResponseDto,
    description: '保存成功，返回保存后的导师专业档案（含 upsert 建行后的 id）',
  })
  @ApiForbiddenResponse({
    description: '调用者不是导师（403 / 10003）',
    schema: {
      example: errExample(
        ErrorCode.FORBIDDEN,
        '只有导师（internalMentor / externalMentor / teacher）有专业档案',
      ),
    },
  })
  @ApiConflictResponse({
    description: 'R55 status 门：当前状态不可直接修改（409 / 31103）',
    schema: {
      oneOf: errExamples(
        [
          ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
          '导师专业档案在审，撤回后再改',
        ],
        [
          ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
          '导师专业档案已生效，改字段走信息修改申请',
        ],
        [
          ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
          '导师专业档案已冻结，不能修改',
        ],
        [
          ErrorCode.MENTOR_PROFILE_NOT_SUBMITTABLE,
          '导师专业档案已移除，不能修改',
        ],
      ).map((example) => ({ example })),
    },
  })
  async upsertMyProfile(
    @Body() dto: UpdateMentorProfileDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<MentorProfileResponseDto> {
    return this.mentorService.upsertMyProfile(dto, caller);
  }

  @Put('profiles/:id')
  @RequirePermission('mentor:admin-update')
  @DataScope('all')
  @ApiOperation({
    summary: '后台改导师填报字段（双创学院管理员，必须留痕）',
    description:
      '双创学院管理员纠正**任意导师**的 7 个可填报字段（审核通过的档案录错了也得能改）。' +
      '权限码 `mentor:admin-update`；数据范围天花板 **`all`**（不夹窄，角色的 ' +
      'data_scope 自己收窄，越权 **403 / 10003**）。请求体是 `UpdateMentorProfileDto`' +
      '（复用，不复制）：**增量语义**——省略 = 不动、显式 null = 清空、' +
      'researchFields 传数组 = 整体替换；`id` / `personId` / `mentorType` / `status` / ' +
      '未知字段一律 **400 / 10001**。**status 由审核流驱动，本接口没有写口**；' +
      '但管理员是纠数据，不看流程态——status 0–5 的行都能改。' +
      '**R49**：内校导师的 affiliateOrg / socialRoles 落库恒置 null（不是 400）。' +
      '`:id` 不存在或已软删 → **404 / 31102**。' +
      '**每次成功都落一行 SysOpLog**（targetType=mentorProfile，before / after 是 7 字段' +
      '完整快照），且与落库**同一次事务**：留痕写失败则字段也回滚（不留痕的修改入口一律不给）。',
  })
  @ApiBody({
    type: UpdateMentorProfileDto,
    description:
      '要改的字段（增量语义，同 PUT /mentor/profile 的入参白名单）。' +
      'id / personId / mentorType / status 一律 400 / 10001',
  })
  @ApiOkResponse({
    type: MentorProfileResponseDto,
    description: '修改成功，返回修改后的导师专业档案（status / personId 不变）',
  })
  @ApiNotFoundResponse({
    description: '档案不存在或已软删（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码或目标档案不在数据范围内（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.FORBIDDEN, '无权限访问：缺少 mentor:admin-update'],
        [ErrorCode.FORBIDDEN, '无权限'],
      ).map((example) => ({ example })),
    },
  })
  async adminUpdateProfile(
    @Param() params: MentorProfileParamDto,
    @Body() dto: UpdateMentorProfileDto,
    @CurrentUser() caller: RequestUser,
    @Req() req: Request,
  ): Promise<MentorProfileResponseDto> {
    return this.mentorService.adminUpdateProfile(
      BigInt(params.id),
      dto,
      caller,
      toRequestMeta(req),
    );
  }
}

/**
 * 只取 path（不含 query）与来源标识（同 mentor-application / file controller
 * 的同名函数）。`req.path` 受 `sys_op_log.path` 的 VARCHAR(200) 约束，超长截断——
 * 日志宁可丢尾巴，也不要因为一个超长 URL 把业务请求打成 500。
 */
function toRequestMeta(req: Request): AdminUpdateRequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    method: req.method,
    path: req.path.slice(0, 200),
    ...(typeof req.ip === 'string' && req.ip !== '' ? { ip: req.ip } : {}),
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
  };
}
