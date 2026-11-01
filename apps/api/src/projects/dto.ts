// Request DTOs for the Projects CRUD controller.
//
// Validated with class-validator against the same ValidationPipe the app
// installs (whitelist + transform). A project is the top-level scope; it has no
// owner (1 user, local-first, no auth — Global Constraint).

import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Body for `POST /projects`. `description` is optional. */
export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

/** Body for `PATCH /projects/:id` — rename only. */
export class RenameProjectDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}
