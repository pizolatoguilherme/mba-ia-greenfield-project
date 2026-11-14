/** Number of multipart parts needed to upload `size` bytes in `partSize` chunks. */
export function computePartCount(size: number, partSize: number): number {
  return Math.ceil(size / partSize);
}
