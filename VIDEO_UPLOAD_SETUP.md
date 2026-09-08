# Course video upload setup

This version supports uploading lesson videos from the Add Course and Edit Course pages.

- Supported: MP4, WebM, OGG, MOV
- Maximum: 50 MB per video
- Videos are uploaded directly from the browser to Cloudinary, then only the resulting URLs are sent to Vercel. This avoids Vercel 413 FUNCTION_PAYLOAD_TOO_LARGE errors.
- A video upload for Lesson 1 goes to Lesson 1, Lesson 2 to Lesson 2, etc.
- You can still use YouTube/direct video URLs in the curriculum.

## Environment variables

Add these to `.env.local` for local development and to Vercel Project Settings → Environment Variables:

```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
CLOUDINARY_UPLOAD_PRESET=your_unsigned_upload_preset
```

The Cloudinary account must allow video uploads. Do not commit the secret values to GitHub.

## Important for Vercel

Create an **Unsigned Upload Preset** in Cloudinary and set its name as `CLOUDINARY_UPLOAD_PRESET` in Vercel. The browser uploads videos directly to Cloudinary, so large video files do not pass through the Vercel serverless function.
