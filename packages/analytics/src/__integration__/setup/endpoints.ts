/**
 * `endpoints.ts` — single source of truth for the MinIO + Iceberg REST
 * stack coordinates used across the integration suite.
 *
 * Values default to the ports and credentials baked into
 * `infra/analytics-minio/docker-compose.yml`. Env vars override each
 * knob so a developer can point the suite at an already-running stack
 * on non-standard ports (see the compose README's "Port collisions"
 * section).
 */
export interface Endpoints {
  s3Endpoint: string
  s3AccessKey: string
  s3SecretKey: string
  s3Region: string
  s3Bucket: string
  /** Iceberg REST catalog root (path-less; the client appends `/v1/…`). */
  restEndpoint: string
  /** REST-side warehouse identifier — matches `CATALOG_WAREHOUSE` on the container. */
  warehouseName: string
}

export function endpoints(): Endpoints {
  return {
    s3Endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
    s3AccessKey: process.env.TEST_S3_ACCESS_KEY ?? 'minio',
    s3SecretKey: process.env.TEST_S3_SECRET_KEY ?? 'minio-testing-password',
    s3Region: process.env.TEST_S3_REGION ?? 'us-east-1',
    s3Bucket: process.env.TEST_S3_BUCKET ?? 'warehouse',
    restEndpoint: process.env.TEST_CATALOG_ENDPOINT ?? 'http://localhost:8181',
    warehouseName: process.env.TEST_CATALOG_WAREHOUSE ?? 'warehouse',
  }
}
