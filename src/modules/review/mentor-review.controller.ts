import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { DataScope } from '../../common/decorators/data-scope.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample, errExamples } from '../../common/dto/err-example';
import { MentorReviewParamDto } from './dto/mentor-review-param.dto';
import { QueryReviewDto } from './dto/query-review.dto';
import { ReviewListResponseDto } from './dto/review-response.dto';
import { ReviewService } from './review.service';

/**
 * 导师维度的评价列表（P3 Task 34）——一条路由：`GET /mentors/:mentorId/reviews`。
 *
 * 与 `/appointments/:id/review` 的区别是**视角**：那条看的是「一条预约的评价」，
 * 这条看的是「一位导师收到的全部评价」，带全量汇总 `summary`（给检索页画星）。
 *
 * 四个角色都能读（`review:list`）：学生看导师评分是检索的刚需，导师看自己的
 * 评价是改进的依据，管理员看是考核的输入。响应**匿名**（R44），所以放开的
 * 是「评价内容」，不是「谁评的」。
 */
@ApiTags('评价')
@Controller('mentors')
export class MentorReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Get(':mentorId/reviews')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('review:list')
  @DataScope('all')
  @ApiOperation({
    summary: '导师收到的评价列表与汇总',
    description:
      '`{mentorId}` 是 `MentorProfile.id`。按 `createdAt DESC, id DESC` 分页；' +
      '`summary` 是**全量**口径（不受分页影响）：`count` 与四个均值。' +
      '**没有评价时四个均值是 `null`，不是 0**——「没人评」与「评了 0 分」不是一回事。' +
      '档案不存在 / 未生效 → **404 / 31102**。响应**匿名**（R44）。',
  })
  @ApiOkResponse({
    type: ReviewListResponseDto,
    description:
      '评价列表（`list` / `total` / `page` / `pageSize` / `summary`）',
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
    description: '缺权限码 review:list（403 / 10003）',
    schema: {
      oneOf: errExamples([ErrorCode.FORBIDDEN, '无权限']).map((example) => ({
        example,
      })),
    },
  })
  async list(
    @Param() params: MentorReviewParamDto,
    @Query() query: QueryReviewDto,
  ): Promise<ReviewListResponseDto> {
    return this.reviewService.listByMentor(BigInt(params.mentorId), query);
  }
}
