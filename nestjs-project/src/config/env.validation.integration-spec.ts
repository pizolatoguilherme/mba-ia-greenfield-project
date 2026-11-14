import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
  REDIS_HOST: 'redis',
};

const validateWithout = (key: keyof typeof requiredEnv) => {
  const env: Record<string, string> = { ...requiredEnv };
  delete env[key];
  return envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({}) as {
      value: Record<string, unknown>;
      error: unknown;
    };
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue', () => {
  it.each([
    'S3_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'REDIS_HOST',
  ] as const)('should reject a missing %s, naming the key', (key) => {
    const { error } = validateWithout(key);
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should apply the decided upload and delivery defaults', () => {
    const { value, error } = validate({}) as {
      value: Record<string, unknown>;
      error: unknown;
    };
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_REGION: 'us-east-1',
      S3_VIDEOS_BUCKET: 'videos',
      S3_THUMBNAILS_BUCKET: 'thumbnails',
      UPLOAD_PART_SIZE_BYTES: 16777216,
      UPLOAD_PART_URL_TTL_SECONDS: 3600,
      DELIVERY_URL_TTL_SECONDS: 21600,
      UPLOAD_ABANDON_AFTER_HOURS: 24,
      REDIS_PORT: 6379,
    });
  });

  it('should reject a non-URI S3_ENDPOINT', () => {
    const { error } = validate({ S3_ENDPOINT: 'minio' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should reject a part size below the S3 minimum of 5 MiB', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject a URL TTL above the SigV4 maximum of 7 days', () => {
    const { error } = validate({ DELIVERY_URL_TTL_SECONDS: '604801' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('DELIVERY_URL_TTL_SECONDS');
  });
});
