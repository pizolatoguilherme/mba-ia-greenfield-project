const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Object keys are derived only from the internal video UUID, never from the
 * user-supplied filename, so uploads cannot collide or traverse paths.
 */
function assertVideoId(videoId: string): void {
  if (!UUID_PATTERN.test(videoId)) {
    throw new Error(`Invalid video id for storage key: ${videoId}`);
  }
}

/** Key of the source video in the videos bucket. */
export function videoSourceKey(videoId: string): string {
  assertVideoId(videoId);
  return `${videoId}/source`;
}

/** Key of the automatically generated thumbnail in the thumbnails bucket. */
export function autoThumbnailKey(videoId: string): string {
  assertVideoId(videoId);
  return `${videoId}/auto.jpg`;
}
