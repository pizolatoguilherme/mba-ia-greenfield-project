import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  MAX_VIDEO_SIZE_BYTES,
} from '../videos.constants';

export class CreateVideoDto {
  /** Video title, 1–100 characters after trim. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  /** Original client filename (metadata only). */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  /** Declared file size in bytes, up to 10 GiB. */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size: number;

  /** MIME type of the source file. */
  @IsIn(ALLOWED_VIDEO_CONTENT_TYPES)
  contentType: string;
}
