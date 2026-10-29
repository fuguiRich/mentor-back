import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DataScope } from '../../common/decorators/data-scope.decorator';
import type { RequestUser } from '../../common/context/request-context';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample, errExamples } from '../../common/dto/err-example';
import { NoEnvelope } from '../../common/decorators/no-envelope.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import {
  AttachMaterialDto,
  MentorMaterialItemParamDto,
  MentorMaterialParamDto,
} from './dto/attach-material.dto';
import {
  MaterialListResponseDto,
  MaterialResponseDto,
} from './dto/material-response.dto';
import { MentorMaterialService } from './mentor-material.service';

/**
 * 导师佐证材料（Task 16+17）——挂在 `/mentor-applications/:id` 下的子资源，
 * 与 `MentorApplicationController` 同前缀、不同路径段，不冲突。
 *
 * 预览 / 下载走**业务路由**（R60），不复用 `/files/:id/*`：那两条只挂
 * `file:list` 门、不做按申请的归属校验，持有 file:list 的人能下任何文件——
 * 正是计划要禁的「有 token 就能下」。本控制器的五条路由按**所属申请**鉴权。
 */
@ApiTags('佐证材料')
@Controller('mentor-applications')
export class MentorMaterialController {
  constructor(private readonly mentorMaterialService: MentorMaterialService) {}

  @Post(':id/materials')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('mentor-application:submit')
  @DataScope('self')
  @ApiOperation({
    summary: '挂接佐证材料到入驻申请',
    description:
      '把 `POST /files` 上传的文件挂到申请上（上传时 ownerType / ownerId 必须' +
      "成对给出 `'MentorApplication'` + 本申请 ID）。请求体 `{ fileId, kind }`：" +
      "kind 只认 **1 职称证书 | 2 行业资质 | 3 其他**，传 0 / 4 / 'x' 一律 " +
      '**400 / 10001**（data.fields 点名 kind，无行落库）；未知字段同判 400。' +
      '**只能挂自己的申请**（身份链比对 applicantId，越权 403 不是 404）；' +
      '学生不能挂（403）。只在 `status ∈ {2 COLLEGE_REVIEWING, 3 ' +
      'COLLEGE_REJECTED}` 可挂（R62，其余 409 / 31105）；文件归属不符 ' +
      '**404 / 28101**（不存在 / 无归属 / 归属不符同码同文案）；同一 fileId ' +
      '重复挂 **409 / 10006**（唯一性按未删行算，摘后可再挂）。',
  })
  @ApiBody({
    type: AttachMaterialDto,
    description:
      '{ fileId: string; kind: 1 | 2 | 3 }。kind / fileId 之外的字段 → 400 / 10001',
  })
  @ApiCreatedResponse({
    type: MaterialResponseDto,
    description: '挂接成功（201），返回材料行（含文件名 / 大小）',
  })
  @ApiBadRequestResponse({
    description: 'kind 不是 1 / 2 / 3、fileId 非法或有未知字段（400 / 10001）',
    schema: {
      example: errExample(ErrorCode.PARAM_INVALID, '参数校验失败'),
    },
  })
  @ApiNotFoundResponse({
    description:
      '申请不存在（404 / 31104）或文件不存在 / 无归属 / 归属不符（404 / 28101，同码同文案）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.MENTOR_APPLICATION_NOT_FOUND, '入驻申请不存在'],
        [ErrorCode.FILE_NOT_FOUND, '文件不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description: '不是申请人本人 / 学生挂材料（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.FORBIDDEN, '无权限'],
        [
          ErrorCode.FORBIDDEN,
          '只有导师（internalMentor / externalMentor）能管理佐证材料',
        ],
      ).map((example) => ({ example })),
    },
  })
  @ApiConflictResponse({
    description: '状态不允许挂（409 / 31105）或重复挂（409 / 10006）',
    schema: {
      oneOf: errExamples(
        [
          ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
          '当前状态不允许该操作',
        ],
        [ErrorCode.CONFLICT, '同一文件不能重复挂到同一申请'],
      ).map((example) => ({ example })),
    },
  })
  async attach(
    @Param() param: MentorMaterialParamDto,
    @Body() dto: AttachMaterialDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<MaterialResponseDto> {
    return this.mentorMaterialService.attach(BigInt(param.id), dto, caller);
  }

  @Get(':id/materials')
  @RequirePermission('mentor-application:list')
  @DataScope('all')
  @ApiOperation({
    summary: '列出申请的全部佐证材料',
    description:
      '天花板 **`all`** + 服务内可见性断言：申请人本人**或**数据范围覆盖' +
      '申请人部门才可见（assertDeptVisible，越权 403 / 10003 不是 404）——' +
      '只看权限码不够，持 mentor-application:list 的外院管理员也不许看本院' +
      '之外的材料。全量一页（不收分页参数）：条数有界，page 恒 1、pageSize = total。',
  })
  @ApiOkResponse({
    type: MaterialListResponseDto,
    description: '该申请的全部佐证材料（未删行，挂接序）',
  })
  @ApiNotFoundResponse({
    description: '申请不存在或已软删（404 / 31104）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_APPLICATION_NOT_FOUND,
        '入驻申请不存在',
      ),
    },
  })
  @ApiForbiddenResponse({
    description: '申请人部门不在数据范围内（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async list(
    @Param() param: MentorMaterialParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<MaterialListResponseDto> {
    return this.mentorMaterialService.list(BigInt(param.id), caller);
  }

  @Delete(':id/materials/:materialId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @RequirePermission('mentor-application:submit')
  @DataScope('self')
  @ApiOperation({
    summary: '摘除佐证材料（软删）',
    description:
      '**无请求体**（出现字段 → 400 / 10001）。只能摘自己的申请（身份链，' +
      '越权 403）；学生不能摘；只在 `status ∈ {2, 3}` 可摘（R62，其余 ' +
      '409 / 31105）。摘除是**软删**（R63）：材料行打 deletedAt 标记，' +
      '`SysFile` **不动**（判据 16），摘后同一 fileId 允许再挂（唯一性按' +
      '未删行算）。`:materialId` 不存在 / 已软删 / 不属于本申请 → 404 / 31107。',
  })
  @ApiNoContentResponse({ description: '摘除成功（204），响应体为空' })
  @ApiNotFoundResponse({
    description:
      '申请不存在（404 / 31104）或材料不存在 / 已软删（404 / 31107）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.MENTOR_APPLICATION_NOT_FOUND, '入驻申请不存在'],
        [ErrorCode.MENTOR_MATERIAL_NOT_FOUND, '佐证材料不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description: '不是申请人本人 / 学生摘材料（403 / 10003）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.FORBIDDEN, '无权限'],
        [
          ErrorCode.FORBIDDEN,
          '只有导师（internalMentor / externalMentor）能管理佐证材料',
        ],
      ).map((example) => ({ example })),
    },
  })
  @ApiConflictResponse({
    description: '状态不允许摘（409 / 31105）',
    schema: {
      example: errExample(
        ErrorCode.MENTOR_APPLICATION_TRANSITION_INVALID,
        '当前状态不允许该操作',
      ),
    },
  })
  async remove(
    @Param() param: MentorMaterialItemParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<void> {
    await this.mentorMaterialService.remove(
      BigInt(param.id),
      BigInt(param.materialId),
      caller,
    );
  }

  @Get(':id/materials/:materialId/preview')
  @NoEnvelope()
  @RequirePermission('mentor-application:list')
  @DataScope('all')
  @ApiOperation({
    summary: '行内预览佐证材料',
    description:
      '按**所属申请**鉴权（R60，不是有 token 就能下）：申请人本人或数据范围' +
      '覆盖申请人部门才可见（越权 403 / 10003）。`Content-Disposition: inline`' +
      '（按 mimeType 渲染）。返回的是文件字节流，**不是 JSON**。' +
      '`:materialId` 不存在 / 已软删 / 不属于本申请 → 404 / 31107；' +
      '文件归属不符同 404 / 28101「文件不存在」。',
  })
  @ApiProduces(
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'application/pdf',
    'application/octet-stream',
  )
  @ApiOkResponse({ description: '返回文件字节流（不是 JSON）' })
  @ApiNotFoundResponse({
    description:
      '申请不存在（404 / 31104）/ 材料不存在（404 / 31107）/ 文件不存在（404 / 28101）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.MENTOR_APPLICATION_NOT_FOUND, '入驻申请不存在'],
        [ErrorCode.MENTOR_MATERIAL_NOT_FOUND, '佐证材料不存在'],
        [ErrorCode.FILE_NOT_FOUND, '文件不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description: '申请人部门不在数据范围内（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async preview(
    @Param() param: MentorMaterialItemParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.mentorMaterialService.preview(
      BigInt(param.id),
      BigInt(param.materialId),
      caller,
    );
  }

  @Get(':id/materials/:materialId/download')
  @NoEnvelope()
  @RequirePermission('mentor-application:list')
  @DataScope('all')
  @ApiOperation({
    summary: '下载佐证材料',
    description:
      '按**所属申请**鉴权（同预览的可见性）。`Content-Disposition: attachment`' +
      '（按上传原名另存，固定 octet-stream 才会另存为而不是试着渲染）。' +
      '返回的是文件字节流，**不是 JSON**。',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: '返回文件字节流（不是 JSON）' })
  @ApiNotFoundResponse({
    description:
      '申请不存在（404 / 31104）/ 材料不存在（404 / 31107）/ 文件不存在（404 / 28101）',
    schema: {
      oneOf: errExamples(
        [ErrorCode.MENTOR_APPLICATION_NOT_FOUND, '入驻申请不存在'],
        [ErrorCode.MENTOR_MATERIAL_NOT_FOUND, '佐证材料不存在'],
        [ErrorCode.FILE_NOT_FOUND, '文件不存在'],
      ).map((example) => ({ example })),
    },
  })
  @ApiForbiddenResponse({
    description: '申请人部门不在数据范围内（403 / 10003）',
    schema: { example: errExample(ErrorCode.FORBIDDEN, '无权限') },
  })
  async download(
    @Param() param: MentorMaterialItemParamDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<StreamableFile> {
    return this.mentorMaterialService.download(
      BigInt(param.id),
      BigInt(param.materialId),
      caller,
    );
  }
}
