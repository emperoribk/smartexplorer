/** Converts an OS filesystem path (Windows or POSIX) into an `ssfile://` URL
 *  that <img>/<video> tags can load directly. We don't use plain `file://`
 *  here: Chromium blocks it from a page served over http:// (which is how
 *  the renderer loads in dev, for hot-reload), so main.ts registers a small
 *  custom protocol that behaves the same way in dev and in the packaged app. */
export function toFileUrl(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) normalized = "/" + normalized; // C:/x -> /C:/x
  const encoded = normalized.split("/").map(encodeURIComponent).join("/");
  return "ssfile://local" + encoded;
}
