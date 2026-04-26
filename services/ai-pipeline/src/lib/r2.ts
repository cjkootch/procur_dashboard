import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

let cached: S3Client | null = null;

function getClient(): S3Client {
  if (cached) return cached;
  const accountId = required('R2_ACCOUNT_ID');
  const accessKeyId = required('R2_ACCESS_KEY_ID');
  const secretAccessKey = required('R2_SECRET_ACCESS_KEY');
  cached = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cached;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export type UploadResult = { key: string; url: string };

/**
 * Upload a buffer to the configured R2 bucket and return the resolved
 * public URL (R2_PUBLIC_URL + '/' + key). Caller is responsible for
 * choosing a stable key — typically `tender-documents/<documentId>.<ext>`.
 */
export async function uploadBuffer(
  key: string,
  body: Uint8Array | Buffer,
  contentType: string,
): Promise<UploadResult> {
  const bucket = required('R2_BUCKET_NAME');
  const publicUrl = required('R2_PUBLIC_URL');
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return { key, url: `${publicUrl.replace(/\/$/, '')}/${key}` };
}
