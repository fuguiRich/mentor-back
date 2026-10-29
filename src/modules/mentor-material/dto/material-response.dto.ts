import { ApiProperty } from '@nestjs/swagger';
import { PageResponseDto } from '../../../common/dto/page-response.dto';
import { MATERIAL_KIND_VALUES, type MaterialKind } from './attach-material.dto';

/**
 * 一条佐证材料（材料行 + 文件展示元数据）。
 * BIGINT 一律对外**字符串**（RES-04，直接 JSON 化会抛）。
 * 文件名 / 大小 / MIME 来自 `SysFile` 行——摘材料不动文件，文件被删时兜底空值。
 */
export class MaterialResponseDto {
  @ApiProperty({ description: '材料行 ID', example: '1' })
  id!: string;

  @ApiProperty({ description: '所属入驻申请 ID', example: '1' })
  applicationId!: string;

  @ApiProperty({ description: '文件 ID（SysFile 行）', example: '1' })
  fileId!: string;

  @ApiProperty({
    description: '材料类型：1 职称证书 | 2 行业资质 | 3 其他',
    enum: [...MATERIAL_KIND_VALUES],
    example: 1,
  })
  kind!: MaterialKind;

  @ApiProperty({
    description: '上传时的原始文件名（来自 SysFile，只用于回显）',
    example: '职称证书.pdf',
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
    example: '2026-10-29T03:00:00.000Z',
  })
  createdAt!: string;
}

/**
 * 列材料的响应。RES-06 的分页结构照用，但本接口是**申请子资源、有界全量返回**：
 * 不收分页参数，一次出该申请的全部材料——`page` 恒 1、`pageSize` = total
 * （「全量一页」形状，避免裸数组触 RES-06 的明文反例）。
 * 重写 list 的注解：Swagger 推断不出泛型元素类型（同 query-application.dto.ts）。
 */
export class MaterialListResponseDto extends PageResponseDto<MaterialResponseDto> {
  @ApiProperty({
    type: () => [MaterialResponseDto],
    description: '该申请的全部佐证材料（未删行，挂接序）',
  })
  declare list: MaterialResponseDto[];
}
