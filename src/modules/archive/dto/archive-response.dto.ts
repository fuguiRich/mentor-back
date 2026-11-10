import { ApiProperty } from '@nestjs/swagger';

/** 归档附件元数据（文件本体走 preview / download 字节流） */
export class ArchiveFileRefDto {
  @ApiProperty({ description: '文件 ID', example: '12' })
  id!: string;

  @ApiProperty({ description: '原始文件名', example: '获奖证书.pdf' })
  originName!: string;

  @ApiProperty({ description: 'MIME 类型', example: 'application/pdf' })
  mimeType!: string;

  @ApiProperty({ description: '文件大小（字节）', example: 102400 })
  size!: number;
}

/**
 * 一条归档条目的响应形状（RES-03 / RES-04：显式映射，不序列化实体）。
 *
 * `archivedAt` 是**时刻**（ISO 8601）；`retentionUntil` 是**日期**
 * （`YYYY-MM-DD`，列是 `DATE`）——两类字段口径不同，混用会差一天。
 */
export class ArchiveResponseDto {
  @ApiProperty({
    description: '归档条目 ID（BIGINT 对外字符串）',
    example: '1',
  })
  id!: string;

  @ApiProperty({
    description: '归档目标类型',
    example: 'MentorApplication',
  })
  targetType!: string;

  @ApiProperty({ description: '归档目标 ID（弱关联）', example: '12' })
  targetId!: string;

  @ApiProperty({ description: '归档标题快照', example: '导师入驻申请 #12' })
  title!: string;

  @ApiProperty({
    description: '归属导师快照（MentorProfile.id）；未记录时为 null',
    type: String,
    nullable: true,
    example: '3',
  })
  mentorId!: string | null;

  @ApiProperty({
    description: '归属学院快照（SysDept.id）；未记录时为 null',
    type: String,
    nullable: true,
    example: '2',
  })
  deptId!: string | null;

  @ApiProperty({
    description:
      '归档分类：`mentor-application` / `assessment` / `guidance-record` / `achievement` / `other`',
    example: 'assessment',
  })
  category!: string;

  @ApiProperty({
    description: '1 核心（永久保存）/ 0 非核心（到期清理）',
    enum: [0, 1],
    example: 1,
  })
  core!: number;

  @ApiProperty({
    description: '归档时间（ISO 8601）',
    example: '2026-11-02T02:00:00.000Z',
  })
  archivedAt!: string;

  @ApiProperty({
    description: '保留截止日，`YYYY-MM-DD`；核心材料恒为 null',
    type: String,
    nullable: true,
    example: '2031-11-02',
  })
  retentionUntil!: string | null;

  @ApiProperty({
    description: '归档摘要；未填时为 null',
    type: String,
    nullable: true,
    example: '手工归档的非核心材料',
  })
  summary!: string | null;

  @ApiProperty({
    description: '归档附件 ID 数组；没有附件时为 []',
    type: [String],
    example: ['12'],
  })
  fileIds!: string[];

  @ApiProperty({
    description: '归档附件元数据；没有附件时为 []',
    type: [ArchiveFileRefDto],
  })
  files!: ArchiveFileRefDto[];

  @ApiProperty({
    description: '创建时间（ISO 8601）',
    example: '2026-11-02T02:00:00.000Z',
  })
  createdAt!: string;
}

/** `GET /archives` 的响应（RES-06） */
export class ArchiveListResponseDto {
  @ApiProperty({ description: '当前页归档', type: [ArchiveResponseDto] })
  list!: ArchiveResponseDto[];

  @ApiProperty({ description: '总条数', example: 5 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
