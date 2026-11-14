import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignPartUrlsDto } from './dto/sign-part-urls.dto';
import { SignedUrlDto, VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';
import type {
  CompleteUploadResult,
  InitiateUploadResult,
  SignPartUrlsResult,
  UploadedPartsResult,
} from './videos.types';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers the video as draft on the caller's channel and opens a multipart upload in storage. No video bytes pass through the API.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    schema: {
      properties: {
        publicId: { type: 'string', example: 'dQw4w9WgXcQ' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['draft'] },
        partSize: { type: 'integer', example: 16777216 },
        partCount: { type: 'integer', example: 64 },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':publicId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Signs presigned PUT URLs (valid 1 h) for the requested parts of a draft video owned by the caller and records upload activity. Call again to re-sign when resuming.',
  })
  @ApiResponse({
    status: 200,
    description: 'Part URLs signed',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'integer', example: 1 },
              url: { type: 'string', format: 'uri' },
            },
          },
        },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number above partCount',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: "Video belongs to another user's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: SignPartUrlsDto,
  ): Promise<SignPartUrlsResult> {
    return this.videosService.signPartUrls(publicId, user.sub, dto);
  }

  @Get(':publicId/upload/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts already stored for a draft video owned by the caller, so an interrupted upload can resume without resending them.',
  })
  @ApiResponse({
    status: 200,
    description: 'Parts already stored, ascending by partNumber',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'integer', example: 1 },
              etag: { type: 'string' },
              size: { type: 'integer', example: 16777216 },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: "Video belongs to another user's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<UploadedPartsResult> {
    return this.videosService.listUploadedParts(publicId, user.sub);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload, checks the assembled size, moves the video to processing and enqueues the processing job.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing enqueued',
    schema: {
      properties: {
        publicId: { type: 'string', example: 'dQw4w9WgXcQ' },
        status: { type: 'string', enum: ['processing'] },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed or the part list does not match the uploaded parts',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: "Video belongs to another user's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Assembled video is larger than 10 GiB',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(publicId, user.sub, dto);
  }

  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get a video by its unique URL',
    description:
      'Returns status, extracted metadata and a presigned thumbnail URL (6 h) when available. Anonymous access.',
  })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.findByPublicId(publicId);
  }

  @Public()
  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Get a playback URL',
    description:
      'Returns a presigned GET URL (6 h) for the source object of a ready video. The storage serves Range/206 directly. Anonymous access.',
  })
  @ApiResponse({ status: 200, type: SignedUrlDto })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('publicId') publicId: string): Promise<SignedUrlDto> {
    return this.videosService.signDelivery(publicId, 'stream');
  }

  @Public()
  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a presigned GET URL (6 h) that downloads the source of a ready video as an attachment with its original (sanitized) file name. Anonymous access.',
  })
  @ApiResponse({ status: 200, type: SignedUrlDto })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('publicId') publicId: string): Promise<SignedUrlDto> {
    return this.videosService.signDelivery(publicId, 'download');
  }
}
