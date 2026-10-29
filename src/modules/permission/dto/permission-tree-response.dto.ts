import { ApiProperty } from '@nestjs/swagger';
import { PermissionResponseDto } from './permission-response.dto';

export class PermissionTreeResponseDto extends PermissionResponseDto {
  @ApiProperty({
    type: () => [PermissionTreeResponseDto],
    description: '子权限点',
  })
  children!: PermissionTreeResponseDto[];
}
