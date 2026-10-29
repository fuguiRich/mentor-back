import { ApiProperty } from '@nestjs/swagger';

export class FileResponseDto {
  @ApiProperty({ description: '文件 ID', example: '1' })
  id!: string;

  @ApiProperty({
    description: '上传时的原始文件名。**只用于回显**，永不参与磁盘路径拼接',
    example: '成绩单.pdf',
  })
  originName!: string;

  @ApiProperty({
    description: '扩展名（小写、不含点）',
    example: 'pdf',
    maxLength: 20,
  })
  ext!: string;

  @ApiProperty({
    description: '服务端按魔数认定的 MIME 类型，不采用客户端声明的值',
    example: 'application/pdf',
    maxLength: 100,
  })
  mimeType!: string;

  @ApiProperty({ description: '字节数', example: 20480, minimum: 1 })
  size!: number;

  @ApiProperty({
    description: '文件内容的 SHA-256（小写 hex）',
    example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    minLength: 64,
    maxLength: 64,
  })
  sha256!: string;

  @ApiProperty({
    description: '上传人用户标识',
    example: '3',
  })
  uploaderId!: string;

  @ApiProperty({
    type: String,
    description:
      "归属的业务对象类型（如 'MentorApplication'）。空 = 无归属的通用文件",
    example: 'MentorApplication',
    nullable: true,
  })
  ownerType!: string | null;

  // type 显式给 String：`string | null` 的 design:type 是 Object，不写就退化成
  // `type: object`（DOC-06），且 *Id 属性的 BIGINT 序列化约定要求 type: string
  @ApiProperty({
    type: String,
    description: '归属的业务对象 ID。与 ownerType 成对出现；对外一律字符串',
    example: '1',
    nullable: true,
  })
  ownerId!: string | null;

  @ApiProperty({
    description: '上传时间（UTC，ISO 8601）',
    example: '2026-10-20T03:00:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    description: '行内预览地址（不带下载提示，浏览器直接渲染）',
    example: '/files/1/preview',
  })
  previewUrl!: string;

  @ApiProperty({
    description: '下载地址（带 attachment 处置，按原始文件名另存）',
    example: '/files/1/download',
  })
  downloadUrl!: string;
}
