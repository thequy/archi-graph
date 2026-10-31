// Request DTO for `POST /branches`.
//
// Validated with class-validator (same ValidationPipe the app installs). Both
// fields are required non-empty strings: `name` for the new candidate, and
// `fromBranchId` identifying the branch to fork from.

import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateBranchDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  fromBranchId!: string;
}

/**
 * Body for `POST /branches/:candidateId/merge`. `resolutions` is an optional
 * map of conflict id -> chosen side ('ours' | 'theirs'). Omitted ⇒ a pure
 * detect-conflicts run. Validated only as an object; the merge logic ignores
 * entries that do not correspond to an actual conflict.
 */
export class MergeBranchDto {
  @IsOptional()
  @IsObject()
  resolutions?: Record<string, 'ours' | 'theirs'>;
}
