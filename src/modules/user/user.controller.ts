import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DataScope } from '../../common/decorators/data-scope.decorator';
import type { RequestUser } from '../../common/context/request-context';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample, errExamples } from '../../common/dto/err-example';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { UserService } from './user.service';
import { UserParamDto } from './dto/user-param.dto';
import { QueryUserDto } from './dto/query-user.dto';
import { CreateUserAccountDto } from './dto/create-user-account.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { ResetUserPasswordDto } from './dto/reset-user-password.dto';
import { AssignUserRolesDto } from './dto/assign-user-roles.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UserDetailResponseDto } from './dto/user-detail-response.dto';
import { UserPageResponseDto } from './dto/user-page-response.dto';

/**
 * 用户管理（Task 6b 收口后）：只读 + 登录态 + 角色绑定 + 一条受限建号。
 * 人员信息（姓名 / 工号 / 部门 / 手机）归源系统，通用增删改路由已删——
 * `SysUser` 的人员字段由 6a 的同步投影维护。
 */
@ApiTags('用户管理')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @RequirePermission('user:list')
  @DataScope('all')
  @ApiOperation({
    summary: '查询用户列表（分页）',
    description:
      '用户管理页的主视图。可按用户名 / 姓名 / 工号 / 部门 / 状态 / **角色**筛选；' +
      '按角色筛选就是「角色的成员列表」（spec 第 4 节把 GET /roles/:id/users 并到了这里）。' +
      '部门是精确匹配，不含下级部门。传了不存在的角色 ID 返回空列表（裁决 R13）。' +
      '返回统一的分页结构 { list, total, page, pageSize }（规范 RES-06）。不返回已软删除的用户。' +
      '**结果受调用者的数据范围约束**（角色的 data_scope：all / deptAndChildren / dept / self，' +
      '多角色取最宽）：范围外的用户不出现。两个筛选字段的口径不同——' +
      '**roleId 与范围求交**（筛出的成员里再取范围内的那部分，不会放宽范围）；' +
      '**deptId 必须在调用者的数据范围内**，超出直接 **403**（10003），不是空列表。',
  })
  @ApiOkResponse({
    type: UserPageResponseDto,
    description:
      '查询成功，返回分页后的用户列表；没有命中时 list 为 []、total 为 0',
  })
  async findPage(
    @Query() query: QueryUserDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<UserPageResponseDto> {
    return this.userService.findPage(query, caller);
  }

  @Get(':id')
  @RequirePermission('user:list')
  @ApiOperation({
    summary: '查询用户详情',
    description:
      '详情页与编辑表单回填用，比列表多一个 roleIds（已分配的角色 ID）。响应不含密码。',
  })
  @ApiOkResponse({
    type: UserDetailResponseDto,
    description: '查询成功，返回用户完整字段与已分配的角色 ID',
  })
  @ApiNotFoundResponse({
    description: '用户不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.USER_NOT_FOUND, '用户不存在'),
    },
  })
  async findOne(@Param() params: UserParamDto): Promise<UserDetailResponseDto> {
    return this.userService.findOne(BigInt(params.id));
  }

  @Post('account')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('user:create')
  @ApiOperation({
    summary: '受限建号（建号 + 绑角色）',
    description:
      '给管理员用的唯一建号入口（Ruling 28）。**只认 6 个字段**：username / realName / ' +
      'employeeNo / deptId / roleIds / password?；mobile / major / className / personType / ' +
      'isSuperAdmin / status 一律不收——请求体里出现未知字段直接 400（全局 ' +
      'forbidNonWhitelisted，判据 7：400 + 账号不创建）。' +
      '**建号即定型**：username / realName / employeeNo / deptId 这 4 个人员信息字段落库后' +
      '不再有任何接口能改，人员信息的修改归源系统（同步投影）。password 与 roleIds 不在定型范围' +
      '——它们是登录态与角色绑定，分别走 PUT /users/:id/password 与 PUT /users/:id/roles。' +
      'roleIds 至少 1 个（去重后仍为空 → 10001）；任一 ID 不存在 → 22101。' +
      'deptId 不存在 → 10001。' +
      'password 可选（8-64）：给就用它，不给就随机生成，两者都以 bcrypt 落库，' +
      '**明文不回、不记日志**；没设口令的账号走 SSO（employeeNo 已落），要给口令用 ' +
      'PUT /users/:id/password。响应是用户详情（含 roleIds），**不含 password**。',
  })
  @ApiCreatedResponse({
    type: UserDetailResponseDto,
    description:
      '创建成功，返回新建账号的详情（含已绑定的 roleIds，不含 password）',
  })
  @ApiNotFoundResponse({
    description: 'roleIds 里有不存在的角色（22101）',
    schema: {
      example: errExample(ErrorCode.ROLE_NOT_FOUND, '角色不存在'),
    },
  })
  @ApiConflictResponse({
    description: '用户名 / 工号已存在',
    schema: {
      oneOf: errExamples(
        [ErrorCode.USER_NAME_TAKEN, '用户名已存在'],
        [ErrorCode.USER_EMPLOYEE_NO_TAKEN, '工号已存在'],
      ).map((example) => ({ example })),
    },
  })
  async createAccount(
    @Body() dto: CreateUserAccountDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<UserDetailResponseDto> {
    return this.userService.createAccount(dto, caller.userId);
  }

  @Put(':id/status')
  @RequirePermission('user:update')
  @ApiOperation({
    summary: '启用 / 停用用户',
    description:
      '切换用户状态。**停用会作废该用户全部已签发令牌**（R14：停用 = 让人不能再访问）；' +
      '启用不会。超管账号不可停用（R7④）。把状态设成当前值时什么都不发生。',
  })
  @ApiOkResponse({
    type: UserResponseDto,
    description: '修改成功，返回修改后的用户记录',
  })
  @ApiConflictResponse({
    description: '目标是超管账号',
    schema: {
      example: errExample(
        ErrorCode.USER_SUPER_ADMIN_PROTECTED,
        '超级管理员受保护，不能执行该操作',
      ),
    },
  })
  async updateStatus(
    @Param() params: UserParamDto,
    @Body() dto: UpdateUserStatusDto,
  ): Promise<UserResponseDto> {
    return this.userService.updateStatus(BigInt(params.id), dto);
  }

  @Put(':id/password')
  @RequirePermission('user:reset-password')
  @ApiOperation({
    summary: '重置用户密码（不校验旧密码）',
    description:
      '管理员重置某个用户的密码。**不校验旧密码**——这是管理员操作，不是本人改密' +
      '（本人改密走 PUT /auth/password）。重置会作废该用户全部已签发令牌（R14）。' +
      '超管账号只有超管能重置（裁决 R21）：user:reset-password 是「不校验旧密码改别人的密码」，' +
      '不加这道门，持有该权限的非超管就能接管超管账号。',
  })
  @ApiOkResponse({
    type: UserResponseDto,
    description: '重置成功，返回用户记录（不含密码）',
  })
  @ApiForbiddenResponse({
    description: '非超管尝试重置超管账号的密码（R21）',
    schema: {
      example: errExample(ErrorCode.FORBIDDEN, '无权限'),
    },
  })
  @ApiNotFoundResponse({
    description: '用户不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.USER_NOT_FOUND, '用户不存在'),
    },
  })
  async resetPassword(
    @Param() params: UserParamDto,
    @Body() dto: ResetUserPasswordDto,
    @CurrentUser() caller: RequestUser,
  ): Promise<UserResponseDto> {
    return this.userService.resetPassword(BigInt(params.id), dto, caller);
  }

  @Put(':id/roles')
  @RequirePermission('user:assign-role')
  @ApiOperation({
    summary: '分配角色（全量覆盖）',
    description:
      '请求里的 roleIds 是**目标集合**，不是增量：没有的新增、多的撤销、传 [] 清空。' +
      '差集在服务端算。每个 ID 都必须存在，否则 22101。' +
      '撤销后重新授予是合法的（连接表物理删除，DB-10）。' +
      '改动立即生效：该用户的权限缓存被清（R10 ③）。',
  })
  @ApiOkResponse({
    type: UserDetailResponseDto,
    description: '分配成功，返回用户详情（含新的 roleIds）',
  })
  @ApiNotFoundResponse({
    description: '用户不存在，或 roleIds 里有不存在的角色',
    schema: {
      oneOf: errExamples(
        [ErrorCode.USER_NOT_FOUND, '用户不存在'],
        [ErrorCode.ROLE_NOT_FOUND, '角色不存在'],
      ).map((example) => ({ example })),
    },
  })
  async assignRoles(
    @Param() params: UserParamDto,
    @Body() dto: AssignUserRolesDto,
  ): Promise<UserDetailResponseDto> {
    return this.userService.assignRoles(BigInt(params.id), dto);
  }
}
