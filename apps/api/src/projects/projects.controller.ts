// HTTP surface for Projects CRUD.
//
//   POST   /projects      { name, description? } -> Project (201)
//   GET    /projects                             -> Project[]
//   GET    /projects/:id                         -> Project | 404
//   PATCH  /projects/:id   { name }              -> Project | 404
//   DELETE /projects/:id                         -> 200 | 404
//
// Creating a project also creates its own `main` branch (ProjectService.create
// delegates to ensureProjectMain). The controller is thin: validate the DTOs,
// map a missing project to a clean 404.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ProjectService, type Project } from './project.service';
import { CreateProjectDto, RenameProjectDto } from './dto';

@Controller('projects')
export class ProjectsController {
  constructor(
    @Inject(ProjectService) private readonly projects: ProjectService,
  ) {}

  @Post()
  async create(@Body() dto: CreateProjectDto): Promise<Project> {
    return this.projects.create(dto.name, dto.description);
  }

  @Get()
  async list(): Promise<Project[]> {
    return this.projects.list();
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<Project> {
    const project = await this.projects.get(id);
    if (!project) {
      throw new NotFoundException(`project not found: ${id}`);
    }
    return project;
  }

  @Patch(':id')
  async rename(
    @Param('id') id: string,
    @Body() dto: RenameProjectDto,
  ): Promise<Project> {
    const project = await this.projects.rename(id, dto.name);
    if (!project) {
      throw new NotFoundException(`project not found: ${id}`);
    }
    return project;
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string): Promise<{ id: string }> {
    const deleted = await this.projects.remove(id);
    if (!deleted) {
      throw new NotFoundException(`project not found: ${id}`);
    }
    return { id };
  }
}
