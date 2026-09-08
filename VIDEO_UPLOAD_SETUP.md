# Course video upload setup

This version supports uploading lesson videos from the Add Course and Edit Course pages.

- Supported: MP4, WebM, OGG, MOV
- Maximum: 50 MB per video
- Videos are uploaded to Cloudinary so they persist on Vercel.
- A video upload for Lesson 1 goes to Lesson 1, Lesson 2 to Lesson 2, etc.
- You can still use YouTube/direct video URLs in the curriculum.

## Environment variables

Add these to `.env.local` for local development and to Vercel Project Settings → Environment Variables:

```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

The Cloudinary account must allow video uploads. Do not commit the secret values to GitHub.
