// Request DTO for `POST /branches`.
//
// Validated with class-validator (same ValidationPipe the app installs). Both
// fields are required non-empty strings: `name` for the new candidate, and
// `fromBranchId` identifying the branch to fork from.

import { IsNotEmpty, IsString } from 'class-validator';

export class CreateBranchDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  fromBranchId!: string;
}
