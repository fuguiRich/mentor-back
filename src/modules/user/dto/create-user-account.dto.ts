import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { IsBigIntId } from '../../../common/decorators/is-bigint-id.decorator';

/**
 * 受限建号（Ruling 28）的入参白名单——**只认这 6 个字段**（红线）。
 *
 * `mobile` / `major` / `className` / `personType` / `isSuperAdmin` / `status`
 * 一律不收：多收一个就是把人员信息的手工入口从后门放回来，`isSuperAdmin`
 * 更是直接的提权口子。未知字段由全局 `ValidationPipe({ forbidNonWhitelisted:
 * true })` 一律 400（判据 7：400 + 账号不创建）——不许给这里加第 7 个字段，
 * 更不许绕开管道手写白名单解析。
 *
 * 刻意**不**用 `OmitType(CreateUserDto, …)` 之类的继承：`CreateUserDto` 本任务
 * 已删，而且继承会把漏网字段悄悄带上。
 */
export class CreateUserAccountDto {
  @ApiProperty({
    description: '用户名（登录名），1-50 个字符，全局唯一',
    example: 'zhangsan',
  })
  @IsString()
  @Length(1, 50, { message: '用户名长度需在 1 到 50 个字符之间' })
  username!: string;

  @ApiProperty({ description: '真实姓名，1-50 个字符', example: '张三' })
  @IsString()
  @Length(1, 50, { message: '真实姓名长度需在 1 到 50 个字符之间' })
  realName!: string;

  @ApiProperty({
    description:
      '工号，1-50 个字符，全局唯一；SSO 靠它 `findByEmployeeNo` 映射本地账号',
    example: 'T2026001',
  })
  @IsString()
  @Length(1, 50, { message: '工号长度需在 1 到 50 个字符之间' })
  employeeNo!: string;

  @ApiProperty({ description: '归属部门 ID', example: '1' })
  @IsBigIntId({ message: '部门 ID 必须是合法的数字 ID' })
  deptId!: string;

  @ApiProperty({
    description:
      '要绑定的角色 ID 集合（BigIntId[]），**至少 1 个**。' +
      '与 PUT /users/:id/roles 不同：那边 [] 是「清空角色」，这边 [] 是「建号没绑角色」' +
      '——比不建更坏（能登录但什么都看不见），直接拒（10001）。' +
      '数组内重复 ID 会被去重；任一 ID 不存在 → 22101。',
    type: [String],
    example: ['1', '2'],
  })
  @IsArray({ message: 'roleIds 必须是数组' })
  @ArrayNotEmpty({ message: 'roleIds 至少要有一个角色' })
  @IsBigIntId({ each: true, message: '角色 ID 必须是合法的数字 ID' })
  roleIds!: string[];

  @ApiPropertyOptional({
    description:
      '初始密码，可选，8-64 个字符。给就用它，不给就随机生成' +
      '（randomBytes(9).toString("base64url")）；两者都以 bcrypt 落库，' +
      '**明文不回、不记日志**。没设口令的账号走 SSO（employeeNo 已落）；' +
      '要给对方口令，超管用 PUT /users/:id/password 设一个他知道的。',
    example: 'Passw0rd!',
  })
  @IsOptional()
  @IsString()
  @Length(8, 64, { message: '密码长度需在 8 到 64 个字符之间' })
  password?: string;
}
