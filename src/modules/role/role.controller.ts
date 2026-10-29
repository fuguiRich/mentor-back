import {
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorCode } from '../../common/constants/error-code';
import { errExample, errExamples } from '../../common/dto/err-example';
import { NoEnvelope } from '../../common/decorators/no-envelope.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RoleService } from './role.service';
import { RoleParamDto } from './dto/role-param.dto';
import { QueryRoleDto } from './dto/query-role.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { UpdateRoleStatusDto } from './dto/update-role-status.dto';
import { AssignRolePermissionsDto } from './dto/assign-role-permissions.dto';
import { RoleResponseDto } from './dto/role-response.dto';
import { RoleDetailResponseDto } from './dto/role-detail-response.dto';
import { RolePageResponseDto } from './dto/role-page-response.dto';

@ApiTags('角色管理')
@Controller('roles')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  @RequirePermission('role:list')
  @ApiOperation({
    summary: '查询角色列表（分页）',
    description:
      '角色管理页的主视图，按名称模糊筛选、按状态筛选。' +
      '返回统一的分页结构 { list, total, page, pageSize }（规范 RES-06）。' +
      '不返回已软删除的角色。角色的成员列表不在这里——走 GET /users?roleId=。',
  })
  @ApiOkResponse({
    type: RolePageResponseDto,
    description:
      '查询成功，返回分页后的角色列表；没有命中时 list 为 []、total 为 0',
  })
  async findPage(@Query() query: QueryRoleDto): Promise<RolePageResponseDto> {
    return this.roleService.findPage(query);
  }

  @Get(':id')
  @RequirePermission('role:list')
  @ApiOperation({
    summary: '查询角色详情',
    description:
      '角色详情页与编辑表单回填用，比列表多一个 permissionIds（当前已分配的权限点 ID）。' +
      '列表不带它，避免每行都去查一次连接表。',
  })
  @ApiOkResponse({
    type: RoleDetailResponseDto,
    description: '查询成功，返回角色完整字段与已分配的权限点 ID',
  })
  @ApiNotFoundResponse({
    description: '角色不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.ROLE_NOT_FOUND, '角色不存在'),
    },
  })
  async findOne(@Param() params: RoleParamDto): Promise<RoleDetailResponseDto> {
    return this.roleService.findOne(BigInt(params.id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('role:create')
  @ApiOperation({
    summary: '新增角色',
    description:
      '新建一个角色。**角色名称不唯一**（同名角色是合法的，按编码区分）；' +
      '角色编码全局唯一，重复回 22102。',
  })
  @ApiCreatedResponse({
    type: RoleResponseDto,
    description: '创建成功，返回新建的角色记录',
  })
  @ApiConflictResponse({
    description: '角色编码已存在',
    schema: {
      example: errExample(ErrorCode.ROLE_CODE_TAKEN, '角色编码已存在'),
    },
  })
  async create(@Body() dto: CreateRoleDto): Promise<RoleResponseDto> {
    return this.roleService.create(dto);
  }

  @Put(':id')
  @RequirePermission('role:update')
  @ApiOperation({
    summary: '修改角色',
    description:
      '修改角色。name 必填——PUT 是全量替换语义；其余字段只传要改的。' +
      '改编码时会校验唯一性。角色的权限集合不在这里改，走 PUT /roles/:id/permissions。',
  })
  @ApiOkResponse({
    type: RoleResponseDto,
    description: '修改成功，返回修改后的角色记录',
  })
  @ApiNotFoundResponse({
    description: '角色不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.ROLE_NOT_FOUND, '角色不存在'),
    },
  })
  async update(
    @Param() params: RoleParamDto,
    @Body() dto: UpdateRoleDto,
  ): Promise<RoleResponseDto> {
    return this.roleService.update(BigInt(params.id), dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @RequirePermission('role:delete')
  @ApiOperation({
    summary: '删除角色（软删除）',
    description:
      '删除一个角色。删除是打标记而非物理删除，数据行保留以便追溯；' +
      '同一事务里会**物理清掉**它的全部成员关系与权限授予。' +
      '这带来一个必须写明的语义：删角色等于把它从所有持有者身上摘掉，' +
      '不拒绝「还有成员」（这是 spec 第 5 节的策略，与部门删除的「有用户就拒绝」不同）。' +
      '内置角色「超级管理员」也一样可删——它只为前端展示，实际权限判断走 is_super_admin 标志。',
  })
  @ApiNoContentResponse({ description: '删除成功，响应体为空' })
  async remove(@Param() params: RoleParamDto): Promise<void> {
    await this.roleService.remove(BigInt(params.id));
  }

  @Put(':id/status')
  @RequirePermission('role:update')
  @ApiOperation({
    summary: '启用 / 停用角色',
    description:
      '切换角色状态。停用后该角色带的权限码立即不再生效（持有者的权限缓存被清，' +
      '下次请求回填时就不含它们）。**不**把持有者踢下线——改权限不等于踢人。' +
      '把状态设成当前值时什么都不发生，缓存也不清。',
  })
  @ApiOkResponse({
    type: RoleResponseDto,
    description: '修改成功，返回修改后的角色记录',
  })
  @ApiNotFoundResponse({
    description: '角色不存在（含已软删除）',
    schema: {
      example: errExample(ErrorCode.ROLE_NOT_FOUND, '角色不存在'),
    },
  })
  async updateStatus(
    @Param() params: RoleParamDto,
    @Body() dto: UpdateRoleStatusDto,
  ): Promise<RoleResponseDto> {
    return this.roleService.updateStatus(BigInt(params.id), dto);
  }

  @Put(':id/permissions')
  @RequirePermission('role:assign-permission')
  @ApiOperation({
    summary: '分配权限（全量覆盖）',
    description:
      '请求里的 permissionIds 是**目标集合**，不是增量：没有的新增、多的撤销、' +
      '传 [] 清空。差集在服务端算，前端不必自己区分"加一个已经有的"。' +
      '每个 ID 都必须存在，否则 23101。撤销后重新授予是合法的（连接表物理删除）。' +
      '改动立即生效：持有该角色的用户权限缓存被清。',
  })
  @ApiOkResponse({
    type: RoleDetailResponseDto,
    description: '分配成功，返回角色详情（含新的 permissionIds）',
  })
  @ApiNotFoundResponse({
    description: '角色不存在，或 permissionIds 里有不存在的权限点',
    schema: {
      oneOf: errExamples(
        [ErrorCode.ROLE_NOT_FOUND, '角色不存在'],
        [ErrorCode.PERMISSION_NOT_FOUND, '权限点不存在'],
      ).map((example) => ({ example })),
    },
  })
  async assignPermissions(
    @Param() params: RoleParamDto,
    @Body() dto: AssignRolePermissionsDto,
  ): Promise<RoleDetailResponseDto> {
    return this.roleService.assignPermissions(BigInt(params.id), dto);
  }
}
