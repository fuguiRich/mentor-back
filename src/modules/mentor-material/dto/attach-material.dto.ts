import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/**
 * `MentorApplicationMaterial.kind` 的全部合法值（@IsIn 与 OpenAPI enum 共用）：
 * 1 职称证书 | 2 行业资质 | 3 其他（计划 Task 16 的精确值）。
 * 传 0 / 4 / 'x' 一律 400 / 10001、data.fields 点名 kind、无行落库。
 */
export const MATERIAL_KIND_VALUES = [1, 2, 3] as const;

export type MaterialKind = (typeof MATERIAL_KIND_VALUES)[number];

/**
 * 挂材料的请求体（`POST /mentor-applications/:id/materials`）。
 * `fileId` 是 `POST /files` 上传返回的文件 ID（对外字符串）。
 * kind / fileId 之外的字段一律 400 / 10001（全局 forbidNonWhitelisted）。
 */
export class AttachMaterialDto {
  @ApiProperty({
    description:
      '文件 ID（POST /files 上传返回的 id；上传时 ownerType / ownerId 必须' +
      "成对给出 `'MentorApplication'` + 本申请 ID）",
    example: '1',
  })
  @IsBigIntId({ message: 'fileId 必须是正整数字符串' })
  fileId!: string;

  @ApiProperty({
    description: '材料类型：1 职称证书 | 2 行业资质 | 3 其他',
    enum: [1, 2, 3],
    example: 1,
  })
  @Type(() => Number)
  @IsIn(MATERIAL_KIND_VALUES as readonly number[], {
    message: 'kind 只能是 1 职称证书 / 2 行业资质 / 3 其他',
  })
  kind!: MaterialKind;
}

/**
 * `:id` 路径参数（挂材料 / 列材料共用）。DTO-02：param 与 body 各自独立。
 * `@ApiProperty` 不能省：@nestjs/swagger 只展开带它的属性，少了它 OpenAPI 里
 * 没有 path 参数（同 query-application.dto.ts 的同名注释）。
 */
export class MentorMaterialParamDto {
  @ApiProperty({ description: '入驻申请 ID', example: '1' })
  @IsBigIntId({ message: '入驻申请 ID 必须是正整数字符串' })
  id!: string;
}

/** `:id` + `:materialId` 双路径参数（摘材料 / 预览 / 下载共用） */
export class MentorMaterialItemParamDto {
  @ApiProperty({ description: '入驻申请 ID', example: '1' })
  @IsBigIntId({ message: '入驻申请 ID 必须是正整数字符串' })
  id!: string;

  @ApiProperty({ description: '佐证材料行 ID', example: '1' })
  @IsBigIntId({ message: '佐证材料 ID 必须是正整数字符串' })
  materialId!: string;
}
