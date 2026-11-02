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
  ApiConflictResponse,
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
import type { RequestUser } from '../../common/context/request-context';
import { errExample } from '../../common/dto/err-example';
import { CreateStudentAchievementDto } from './dto/create-student-achievement.dto';
import { LinkStudentAchievementDto } from './dto/link-student-achievement.dto';
import { QueryStudentAchievementDto } from './dto/query-student-achievement.dto';
import { StudentAchievementParamDto } from './dto/student-achievement-param.dto';
import {
  StudentAchievementListResponseDto,
  StudentAchievementResponseDto,
} from './dto/student-achievement-response.dto';
import { StudentAchievementService } from './student-achievement.service';

/**
 * 学生成果与人工关联（P5 Task 59 / §5.4）。
 *
 * 学院管理员管理本院学生的成果；关联时同事务生成导师 `Achievement`
 * 与归档条目。导师 / 学生只能读与自己相关的部分（`self` 范围）。
 */
@ApiTags('学生成果')
@Controller('student-achievements')
export class StudentAchievementController {
  constructor(
    private readonly studentAchievementService: StudentAchievementService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('student-achievement:manage')
  @DataScope('all')
  @ApiOperation({
    summary: '登记学生双创成果（学院管理员）',
    description:
      '请求体 `{ studentPersonId, mentorProfileId?, type, title, level, awardedAt, ' +
      'proofFileId? }`。带 `mentorProfileId` 时**立即人工关联**：同事务生成一条导师 ' +
      '`Achievement` 并落一条 `core=0` 归档（保留期 = 今天 + ' +
      '`archive.noncore_retention_days`）。学生不存在 → **404 / 10004**；' +
      '外院学生 → **403 / 10003**；导师不存在 / 未生效 → **404 / 31102**。',
  })
  @ApiBody({ type: CreateStudentAchievementDto })
  @ApiCreatedResponse({
    type: StudentAchievementResponseDto,
    description: '登记成功（201）',
  })
  @ApiBadRequestResponse({
    description: 'type / level / awardedAt / 未知字段非法（400 / 10001）',
    schema: { example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败') },
  })
  @ApiForbiddenResponse({
    description: '外院学生或缺权限码（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async create(
    @Body() dto: CreateStudentAchievementDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<StudentAchievementResponseDto> {
    return this.studentAchievementService.create(dto, caller);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('student-achievement:list')
  @DataScope('all')
  @ApiOperation({
    summary: '检索学生成果（§5.4）',
    description:
      '按学生 / 导师 / 类型 / 年份 / 关联状态筛选。数据范围：双创学院看全校；' +
      '学院管理员按学生学院快照只看本院；导师只看关联到自己的；学生只看自己的。' +
      '超出范围 → **403 / 10003**。',
  })
  @ApiOkResponse({
    type: StudentAchievementListResponseDto,
    description: '检索结果（200）',
  })
  @ApiForbiddenResponse({
    description: '超出数据范围（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async list(
    @Query() query: QueryStudentAchievementDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<StudentAchievementListResponseDto> {
    return this.studentAchievementService.list(query, caller);
  }

  @Patch(':id/link')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('student-achievement:manage')
  @DataScope('all')
  @ApiOperation({
    summary: '把学生成果人工关联到导师（§5.4）',
    description:
      '请求体 `{ mentorProfileId }`。同一事务：生成导师 `Achievement` → 回填 ' +
      '`achievementId` → 落 `core=0` 归档。已关联再 link → **409 / 39002**；' +
      '成果不存在 → **404 / 39001**；导师不存在 / 未生效 → **404 / 31102**。',
  })
  @ApiBody({ type: LinkStudentAchievementDto })
  @ApiOkResponse({
    type: StudentAchievementResponseDto,
    description: '关联成功（200）',
  })
  @ApiConflictResponse({
    description: '该成果已关联导师（409 / 39002）',
    schema: {
      example: errExample(
        ErrorCode.STUDENT_ACHIEVEMENT_ALREADY_LINKED,
        '该成果已关联导师',
      ),
    },
  })
  @ApiNotFoundResponse({
    description: '成果不存在 / 导师不存在或未生效（404）',
    schema: {
      example: errExample(
        ErrorCode.STUDENT_ACHIEVEMENT_NOT_FOUND,
        '学生成果不存在',
      ),
    },
  })
  async link(
    @Param() params: StudentAchievementParamDto,
    @Body() dto: LinkStudentAchievementDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<StudentAchievementResponseDto> {
    return this.studentAchievementService.link(BigInt(params.id), dto, caller);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('student-achievement:manage')
  @DataScope('all')
  @ApiOperation({
    summary: '删除学生成果（软删，学院管理员）',
    description:
      '同事务软删关联的导师 `Achievement` 与归档条目。不存在 → **404 / 39001**。',
  })
  @ApiOkResponse({
    description: '删除成功（200）',
    schema: { example: { code: 0, message: 'success', data: { id: '1' } } },
  })
  @ApiNotFoundResponse({
    description: '成果不存在（404 / 39001）',
    schema: {
      example: errExample(
        ErrorCode.STUDENT_ACHIEVEMENT_NOT_FOUND,
        '学生成果不存在',
      ),
    },
  })
  async remove(
    @Param() params: StudentAchievementParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<{ id: string }> {
    return this.studentAchievementService.remove(BigInt(params.id), caller);
  }
}
