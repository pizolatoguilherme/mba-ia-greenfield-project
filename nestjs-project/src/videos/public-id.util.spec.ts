import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('should return 11 characters from the base64url alphabet', () => {
    const id = generatePublicId();

    expect(id).toHaveLength(11);
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should return distinct values across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generatePublicId()));

    expect(ids.size).toBe(1000);
  });
});
