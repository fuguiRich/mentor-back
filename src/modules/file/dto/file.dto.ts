import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';
import { PageResponseDto } from '../../../common/dto/page-response.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { FileResponseDto } from './file-response.dto';

export class FileParamDto {
  // 同 oplog.dto.ts 的 OpLogParamDto：少了 @ApiProperty 就没有 path 参数
  @ApiProperty({ description: '文件 ID', example: '1' })
  @IsBigIntId({ message: '文件 ID 必须是正整数字符串' })
  id!: string;
}

export class QueryFileDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '原始文件名，模糊匹配',
    example: '成绩单',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: '原始文件名长度不能超过 255 个字符' })
  originName?: string;

  @ApiPropertyOptional({
    description: '上传人用户标识',
    example: '3',
  })
  @IsOptional()
  @IsBigIntId({ message: '上传人 ID 必须是正整数字符串' })
  uploaderId?: string;
}

/**
 * 上传时的可选归属。两字段**成对**出现：两个一起给，或都不给
 * （成对校验是跨字段规则，在 service 里判——同 permission.service.ts 的
 * assertTypeCodeConsistent，DTO 的 class-validator 只管单字段）。
 */
export class UploadOwnerDto {
  @ApiPropertyOptional({
    description:
      "归属的业务对象类型（如 'MentorApplication'）。与 ownerId **成对**出现；" +
      '不给 = 无归属的通用文件。通用文件模块不做类型字典——它是业务模块的类型名',
    example: 'MentorApplication',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '归属类型长度不能超过 50 个字符' })
  ownerType?: string;

  @ApiPropertyOptional({
    description: '归属的业务对象 ID。与 ownerType **成对**出现',
    example: '1',
  })
  @IsOptional()
  @IsBigIntId({ message: '归属对象 ID 必须是正整数字符串' })
  ownerId?: string;
}

export class FilePageResponseDto extends PageResponseDto<FileResponseDto> {
  // 重写 list 的注解：Swagger 推断不出泛型元素类型（spec 第 6 节 ⑤）。
  // `declare` 是编译要求：target ES2023 下 useDefineForClassFields 为 true
  // （同 role-page-response.dto.ts）。
  @ApiProperty({
    type: () => [FileResponseDto],
    description: '当前页的文件',
  })
  declare list: FileResponseDto[];
}
