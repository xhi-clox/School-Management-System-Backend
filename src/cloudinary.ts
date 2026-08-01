import { v2 as cloudinary } from 'cloudinary';

function isConfigured(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );
}

if (isConfigured()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

export function isCloudinaryConfigured(): boolean {
  return isConfigured();
}

export function isBase64Image(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:image');
}

export async function uploadBase64Image(dataUrl: string, folder = 'academify'): Promise<string> {
  const result = await cloudinary.uploader.upload(dataUrl, {
    folder,
    resource_type: 'image',
    overwrite: true,
  });
  return result.secure_url;
}
