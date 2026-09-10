# Cloudinary direct video uploads on Vercel

This project uses Cloudinary **unsigned browser-direct uploads** for course thumbnails and lesson videos. The browser uploads media directly to Cloudinary, then submits only the resulting URL to the Vercel app.

## Vercel environment variables

Set these two variables in Vercel Project Settings → Environment Variables:

```text
CLOUDINARY_CLOUD_NAME=your_actual_cloud_name
CLOUDINARY_UPLOAD_PRESET=your_actual_unsigned_preset_name
```

The upload preset must be configured as **Unsigned** in Cloudinary → Settings → Upload → Upload presets.

### Do not add these for this upload flow

```text
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
```

The API secret must never be exposed to browser code. This project no longer uses the server-side Cloudinary SDK for course uploads.

## After changing Vercel variables

1. Save the variables.
2. Redeploy the project.
3. Open Add Course or Edit Course.
4. Upload a video.

If Cloudinary returns `Unknown API key`, verify that the **Cloud Name** is the exact Cloudinary cloud name and that the **Upload Preset** name exactly matches an existing **Unsigned** preset in that same Cloudinary account.
