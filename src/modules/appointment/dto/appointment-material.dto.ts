import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { PageResponseDto } from '../../../common/dto/page-response.dto';
import { toNumberIfNumericString } from './create-appointment.dto';

/**
 * 预约材料的分类取值（R39）：**1 项目计划书 / 2 竞赛备赛资料 / 3 其他**，
 * 对应需求 §2.3 举的辅助材料例子。
 *
 * `appointment_material.kind` 是 `TINYINT NOT NULL`（迁移
 * `20261030230000_add_appointment_material_kind`），因此**挂预约材料时必填**，
 * 响应回真实值。过程材料（`GuidanceMaterial`）**没有分类列**，永不分类
 * （响应 `kind` 恒 null）——两张表不对称是有意为之：需求 §3.5 只给了过程材料
 * 的例子（课件 / 交流记录 / 项目修改意见），没有分类语义。
 */
export const APPOINTMENT_MATERIAL_KIND = {
  PROJECT_PLAN: 1,
  COMPETITION_PREP: 2,
  OTHER: 3,
} as const;

/** 合法的 `kind` 取值（DTO 校验与文档共用） */
export const APPOINTMENT_MATERIAL_KINDS: readonly number[] = [
  APPOINTMENT_MATERIAL_KIND.PROJECT_PLAN,
  APPOINTMENT_MATERIAL_KIND.COMPETITION_PREP,
  APPOINTMENT_MATERIAL_KIND.OTHER,
];

/** 材料来源：预约材料（学生传）/ 过程材料（导师传） */
export const MATERIAL_SOURCE = {
  APPOINTMENT: 'appointment',
  RECORD: 'record',
} as const;

export type MaterialSource =
  (typeof MATERIAL_SOURCE)[keyof typeof MATERIAL_SOURCE];

/**
 * 挂**预约材料**的请求体（`POST /appointments/:id/materials`）。
 *
 * `fileId` 是 `POST /files` 上传返回的文件 ID（对外字符串）；上传时
 * `ownerType` / `ownerId` 必须成对给出 `'Appointment'` + 本预约 ID。
 * `kind` **必填**：1 项目计划书 / 2 竞赛备赛资料 / 3 其他，落库并在响应回显。
 * `fileId` / `kind` 之外的字段一律 400 / 10001（全局 forbidNonWhitelisted）。
 */
export class AttachAppointmentMaterialDto {
  @ApiProperty({
    description:
      '文件 ID（POST /files 上传返回的 id；上传时 ownerType / ownerId 必须' +
      "成对给出 `'Appointment'` + 本预约 ID）",
    example: '1',
  })
  @IsBigIntId({ message: 'fileId 必须是正整数字符串' })
  fileId!: string;

  @ApiProperty({
    description: '材料分类：1 项目计划书 | 2 竞赛备赛资料 | 3 其他',
    enum: [...APPOINTMENT_MATERIAL_KINDS],
    example: 1,
  })
  @Transform(toNumberIfNumericString)
  @IsIn(APPOINTMENT_MATERIAL_KINDS, {
    message: 'kind 只能是 1 项目计划书 / 2 竞赛备赛资料 / 3 其他',
  })
  kind!: number;
}

/**
 * 挂**过程材料**的请求体（`POST /appointments/:id/record/materials`）。
 *
 * 只有 `fileId`：`GuidanceMaterial` 没有分类列，过程材料**不分类**。
 * 故意**不接受** `kind`——收下却丢弃等于假接口（R39）；多传字段按全局
 * `forbidNonWhitelisted` 落 400 / 10001。
 */
export class AttachRecordMaterialDto {
  @ApiProperty({
    description:
      '文件 ID（POST /files 上传返回的 id；上传时 ownerType / ownerId 必须' +
      "成对给出 `'Appointment'` + 本预约 ID）",
    example: '1',
  })
  @IsBigIntId({ message: 'fileId 必须是正整数字符串' })
  fileId!: string;
}

/**
 * `:id` 路径参数（挂预约材料 / 列材料共用）。DTO-02：param 与 body 各自独立。
 * `@ApiProperty` 不能省：@nestjs/swagger 只展开带它的属性，少了它 OpenAPI 里
 * 没有 path 参数（同 appointment-param.dto.ts 的同名注释）。
 */
export class AppointmentMaterialParamDto {
  @ApiProperty({ description: '预约行 ID（BIGINT 对外字符串）', example: '1' })
  @IsBigIntId({ message: '预约 ID 必须是合法的数字 ID' })
  id!: string;
}

/** `:id` + `:materialId` 双路径参数（摘材料共用） */
export class AppointmentMaterialItemParamDto {
  @ApiProperty({ description: '预约行 ID（BIGINT 对外字符串）', example: '1' })
  @IsBigIntId({ message: '预约 ID 必须是合法的数字 ID' })
  id!: string;

  @ApiProperty({
    description: '材料行 ID（预约材料 / 过程材料任一表，BIGINT 对外字符串）',
    example: '1',
  })
  @IsBigIntId({ message: '材料 ID 必须是合法的数字 ID' })
  materialId!: string;
}

/**
 * 一条材料（预约材料或过程材料）。`source` 区分来自哪张表。
 *
 * BIGINT 一律对外字符串（RES-04）；时间 ISO 8601（RES-07）。文件名 / 大小 /
 * MIME 来自 `SysFile`——摘材料不动文件，文件被删时兜底空值，不把列表打成 500。
 */
export class AppointmentMaterialResponseDto {
  @ApiProperty({ description: '材料行 ID（BIGINT 对外字符串）', example: '1' })
  id!: string;

  @ApiProperty({
    description:
      '来源：appointment 预约材料（学生传）/ record 过程材料（导师传）',
    enum: [MATERIAL_SOURCE.APPOINTMENT, MATERIAL_SOURCE.RECORD],
    example: MATERIAL_SOURCE.APPOINTMENT,
  })
  source!: MaterialSource;

  @ApiProperty({ description: '文件 ID（SysFile 行）', example: '1' })
  fileId!: string;

  @ApiProperty({
    description:
      '材料分类：1 项目计划书 | 2 竞赛备赛资料 | 3 其他；过程材料恒为 null',
    type: Number,
    nullable: true,
    example: 1,
  })
  kind!: number | null;

  @ApiProperty({
    description: '上传时的原始文件名（来自 SysFile，只用于回显）',
    example: '项目计划书.pdf',
  })
  originName!: string;

  @ApiProperty({
    description: 'MIME 类型（来自 SysFile，服务端按魔数认定的值）',
    example: 'application/pdf',
  })
  mimeType!: string;

  @ApiProperty({
    description: '字节数（来自 SysFile）',
    example: 20480,
    minimum: 0,
  })
  size!: number;

  @ApiProperty({
    description: '挂接时间（UTC，ISO 8601）',
    example: '2026-10-30T03:00:00.000Z',
  })
  createdAt!: string;
}

/**
 * 列材料的响应。**不分页**（材料是预约子资源、条数有界）：不收分页参数，
 * 一次出该预约的全部材料——沿用 RES-06 的「全量一页」形状
 * （`page` 恒 1、`pageSize` = total），避免裸数组触 RES-06 的明文反例。
 * 重写 list 的注解：Swagger 推断不出泛型元素类型。
 */
export class AppointmentMaterialListResponseDto extends PageResponseDto<AppointmentMaterialResponseDto> {
  @ApiProperty({
    type: () => [AppointmentMaterialResponseDto],
    description: '该预约的全部材料（预约材料在前、过程材料在后，各按 id 升序）',
  })
  declare list: AppointmentMaterialResponseDto[];
}

/** DELETE 的响应体：确认摘掉的是哪一行、来自哪张表 */
export class DeleteAppointmentMaterialResponseDto {
  @ApiProperty({ description: '被摘除的材料行 ID', example: '1' })
  id!: string;

  @ApiProperty({
    description: '来源：appointment 预约材料 / record 过程材料',
    enum: [MATERIAL_SOURCE.APPOINTMENT, MATERIAL_SOURCE.RECORD],
    example: MATERIAL_SOURCE.APPOINTMENT,
  })
  source!: MaterialSource;
}
