import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DataScope } from '../../common/decorators/data-scope.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample, errExamples } from '../../common/dto/err-example';
import type { RequestUser } from '../../common/context/request-context';
import { AchievementService } from './achievement.service';
import {
  CreateAchievementDto,
  QueryAchievementDto,
  UpdateAchievementDto,
} from './dto/achievement.dto';
import {
  MentorAchievementItemParamDto,
  MentorAchievementParamDto,
} from './dto/achievement-param.dto';
import {
  AchievementListResponseDto,
  AchievementResponseDto,
} from './dto/achievement-response.dto';

/**
 * 双创成果登记（P3 Task 36 / §5.2）——**4 条路由**，全挂在 `/mentors` 下：
 *
 * - `POST /mentors/:mentorId/achievements`（导师登记，`achievement:manage`，`@DataScope('self')`）；
 * - `GET /mentors/:mentorId/achievements`（列表，`achievement:list`，`@DataScope('all')` + 服务内部门范围）；
 * - `PATCH /mentors/:mentorId/achievements/:achievementId`（改，`achievement:manage`，`self`）；
 * - `DELETE /mentors/:mentorId/achievements/:achievementId`（软删，`achievement:manage`，`self`）。
 *
 * 登记即生效（R45），没有审核状态——§5.4 的「成果关联归档」归 P4。
 */
@ApiTags('双创成果')
@Controller('mentors')
export class AchievementController {
  constructor(private readonly achievementService: AchievementService) {}

  @Post(':mentorId/achievements')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('achievement:manage')
  @DataScope('self')
  @ApiOperation({
    summary: '登记一条双创成果（导师）',
    description:
      '导师为自己的档案登记一条成果，**登记即生效**（R45）。请求体 ' +
      '`{ type, title, level, awardedAt, description?, proofFileId? }`：' +
      '`type` 1 竞赛获奖 / 2 项目立项 / 3 其他，`level` 1 国家级 … 5 院级（R46，' +
      '立项同用此标尺），`awardedAt` 是 ISO 8601 日期（只取日期部分），' +
      '`proofFileId` 是 `SysFile.id`（裸列无外键，不校验存在性）。' +
      '守卫：`:mentorId` 不是调用者本人的档案 → **404 / 31102**（藏存在性，不是 403）。',
  })
  @ApiBody({ type: CreateAchievementDto })
  @ApiCreatedResponse({
    type: AchievementResponseDto,
    description: '登记成功（201）',
  })
  @ApiBadRequestResponse({
    description:
      'type / level 越界、title 或 description 长度越界、awardedAt 非 ISO 8601、' +
      '未知字段（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiNotFoundResponse({
    description: '导师档案不存在 / 不是本人（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 achievement:manage（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async create(
    @Param() params: MentorAchievementParamDto,
    @Body() dto: CreateAchievementDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AchievementResponseDto> {
    return this.achievementService.create(BigInt(params.mentorId), dto, caller);
  }

  @Get(':mentorId/achievements')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('achievement:list')
  @DataScope('all')
  @ApiOperation({
    summary: '某导师的成果列表',
    description:
      '按 `awardedAt DESC, id DESC` 分页。筛选：`type` / `level` / `year`（四位年份，' +
      '区间半开 `[YYYY-01-01, (YYYY+1)-01-01)`）。可见性：导师本人 / 数据范围覆盖' +
      '**该导师所在部门**的管理员。档案不存在 / 未生效 → **404 / 31102**；' +
      '超出数据范围 → **403 / 10003**。',
  })
  @ApiOkResponse({
    type: AchievementListResponseDto,
    description: '列表（200）',
  })
  @ApiNotFoundResponse({
    description: '导师档案不存在 / 未生效（404 / 31102）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_PROFILE_NOT_FOUND,
        '导师专业档案不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '超出数据范围（403 / 10003）或缺权限码 achievement:list',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async list(
    @Param() params: MentorAchievementParamDto,
    @Query() query: QueryAchievementDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AchievementListResponseDto> {
    return this.achievementService.list(BigInt(params.mentorId), query, caller);
  }

  @Patch(':mentorId/achievements/:achievementId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('achievement:manage')
  @DataScope('self')
  @ApiOperation({
    summary: '修改一条成果（导师）',
    description:
      '只能改 `title` / `level` / `awardedAt` / `description` / `proofFileId`；' +
      '**`type` 不可改**——换了类型等于换了一条成果，统计口径会跟着变，' +
      '历史报表无法解释（R45）。要换类型就删了重建。' +
      '守卫：`:mentorId` 不是本人 → **404 / 31102**；成果不存在 / 不属于本人 → ' +
      '**404 / 36001**。',
  })
  @ApiBody({ type: UpdateAchievementDto })
  @ApiOkResponse({
    type: AchievementResponseDto,
    description: '修改成功（200）',
  })
  @ApiBadRequestResponse({
    description: '字段越界 / 出现 type 或未知字段（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiNotFoundResponse({
    description: '导师档案不是本人（404 / 31102）或成果不存在（404 / 36001）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.MENTOR_PROFILE_NOT_FOUND, '导师专业档案不存在'],
        [ErrorCode.ACHIEVEMENT_NOT_FOUND, '双创成果不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 achievement:manage（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async update(
    @Param() params: MentorAchievementItemParamDto,
    @Body() dto: UpdateAchievementDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<AchievementResponseDto> {
    return this.achievementService.update(
      BigInt(params.mentorId),
      BigInt(params.achievementId),
      dto,
      caller,
    );
  }

  @Delete(':mentorId/achievements/:achievementId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('achievement:manage')
  @DataScope('self')
  @ApiOperation({
    summary: '摘除一条成果（软删）',
    description:
      '软删：成果行打 `deletedAt`，**`SysFile` 不动**；摘后不再出现在列表与考核统计里。' +
      '守卫：`:mentorId` 不是本人 → **404 / 31102**；成果不存在 / 不属于本人 → **404 / 36001**。',
  })
  @ApiOkResponse({
    description: '摘除成功（200），返回 `{ id }`',
    schema: { example: { code: 0, message: 'ok', data: { id: '1' } } },
  })
  @ApiNotFoundResponse({
    description: '导师档案不是本人（404 / 31102）或成果不存在（404 / 36001）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.MENTOR_PROFILE_NOT_FOUND, '导师专业档案不存在'],
        [ErrorCode.ACHIEVEMENT_NOT_FOUND, '双创成果不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description: '缺权限码 achievement:manage（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async remove(
    @Param() params: MentorAchievementItemParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<{ id: string }> {
    return this.achievementService.remove(
      BigInt(params.mentorId),
      BigInt(params.achievementId),
      caller,
    );
  }
}
