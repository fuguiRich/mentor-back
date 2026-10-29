import { ApiProperty } from '@nestjs/swagger';
import { DeptResponseDto } from './dept-response.dto';

export class DeptTreeResponseDto extends DeptResponseDto {
  @ApiProperty({ type: () => [DeptTreeResponseDto], description: '子部门' })
  children!: DeptTreeResponseDto[];
}
