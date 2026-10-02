/**
 * The canvink-web Worker serves the static build from `dist/`. The one
 * exception is the Android APK: Workers static assets stop at 25 MiB, so the
 * APK lives in the R2 bucket `canvink-downloads` (uploaded by
 * scripts/release-android.sh) and is streamed from here.
 */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DOWNLOADS: {
    get(key: string): Promise<{ body: ReadableStream; size: number; httpEtag: string } | null>;
  };
}

const APK_PATH = '/download/Canvink.apk';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== APK_PATH) return env.ASSETS.fetch(request);
    const apk = await env.DOWNLOADS.get('Canvink.apk');
    if (!apk) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : apk.body, {
      headers: {
        'content-type': 'application/vnd.android.package-archive',
        'content-length': String(apk.size),
        'content-disposition': 'attachment; filename="Canvink.apk"',
        // Replaced in place on every release, like the desktop installer.
        'cache-control': 'public, max-age=0, must-revalidate',
        etag: apk.httpEtag,
      },
    });
  },
};
