import { ApiProperty } from '@nestjs/swagger';

export class DependencyStatusDto {
  @ApiProperty({
    description: '该依赖是否连通',
    example: 'up',
    enum: ['up', 'down'],
  })
  status!: 'up' | 'down';

  @ApiProperty({
    description: '不连通时的原因；连通时该字段不出现',
    example: 'connect ECONNREFUSED 127.0.0.1:6379',
    required: false,
  })
  message?: string;
}

export class DependenciesDto {
  @ApiProperty({ description: 'MySQL', type: () => DependencyStatusDto })
  database!: DependencyStatusDto;

  @ApiProperty({ description: 'Redis', type: () => DependencyStatusDto })
  redis!: DependencyStatusDto;
}

export class HealthResponseDto {
  @ApiProperty({
    description: '全部依赖连通时为 ok，任一不通为 error',
    example: 'ok',
    enum: ['ok', 'error'],
  })
  status!: 'ok' | 'error';

  @ApiProperty({ description: '各依赖的连通情况', type: () => DependenciesDto })
  dependencies!: DependenciesDto;
}
