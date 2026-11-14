import { computePartCount } from './upload-parts.util';

const PART_SIZE = 16777216; // 16 MiB

describe('computePartCount', () => {
  it('should need one part for a 1-byte file', () => {
    expect(computePartCount(1, PART_SIZE)).toBe(1);
  });

  it('should not add a part for an exact multiple of the part size', () => {
    expect(computePartCount(PART_SIZE, PART_SIZE)).toBe(1);
    expect(computePartCount(PART_SIZE * 3, PART_SIZE)).toBe(3);
  });

  it('should add a part for a remainder of one byte', () => {
    expect(computePartCount(PART_SIZE + 1, PART_SIZE)).toBe(2);
  });

  it('should need 640 parts for 10 GiB', () => {
    expect(computePartCount(10737418240, PART_SIZE)).toBe(640);
  });
});
