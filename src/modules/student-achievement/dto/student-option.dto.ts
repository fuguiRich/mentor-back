import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/** `GET /student-achievements/students` 的查询参数 */
export class QueryStudentOptionDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按姓名 / 学号模糊搜索',
    example: '陈',
  })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(50, { message: 'keyword 最多 50 个字符' })
  keyword?: string;

  @ApiPropertyOptional({
    description: '限定学院（SysDept.id）',
    example: '2',
  })
  @IsOptional()
  @IsBigIntId({ message: 'deptId 必须是合法的数字 ID' })
  deptId?: string;
}

/** 学生下拉选项 */
export class StudentOptionDto {
  @ApiProperty({ description: '学生人员 ID（SyncPerson.id）', example: '5' })
  id!: string;

  @ApiProperty({ description: '学号 / 登录名', example: '20230001' })
  login!: string;

  @ApiProperty({ description: '姓名', example: '陈一鸣' })
  realName!: string;

  @ApiProperty({
    type: String,
    description: '所属学院 ID；没有组织投影时为 null',
    nullable: true,
    example: '2',
  })
  deptId!: string | null;

  @ApiProperty({
    type: String,
    description: '所属学院名；没有组织投影时为 null',
    nullable: true,
    example: '计算机学院',
  })
  deptName!: string | null;

  @ApiProperty({
    type: String,
    description: '专业；未同步时为 null',
    nullable: true,
    example: '软件工程',
  })
  major!: string | null;

  @ApiProperty({
    type: String,
    description: '行政班级；未同步时为 null',
    nullable: true,
    example: '软工 2023-1 班',
  })
  className!: string | null;
}

export class StudentOptionListResponseDto {
  @ApiProperty({ type: [StudentOptionDto] })
  list!: StudentOptionDto[];

  @ApiProperty({ description: '总条数', example: 120 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  pageSize!: number;
}
