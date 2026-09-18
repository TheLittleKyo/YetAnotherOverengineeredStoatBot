/**
 * Shared URL parsing helpers for notification providers.
 * Extracts the relevant identifier (username, handle, channel ID) from a
 * full URL or accepts a bare username.
 */

/**
 * Extract the last path segment from a URL, or return the input as-is if
 * it's not a URL. Strips trailing slashes and query strings.
 *
 * Examples:
 *   extractIdFromUrl('https://twitch.tv/shroud', ['twitch.tv']) → 'shroud'
 *   extractIdFromUrl('https://kick.com/xqc', ['kick.com']) → 'xqc'
 *   extractIdFromUrl('https://x.com/elonmusk', ['x.com', 'twitter.com']) → 'elonmusk'
 *   extractIdFromUrl('https://youtube.com/@MrBeast', ['youtube.com', 'youtu.be']) → '@MrBeast'
 *   extractIdFromUrl('shroud', ['twitch.tv']) → 'shroud'
 *   extractIdFromUrl('', []) → ''
 */
export function extractIdFromUrl(input: string, _domains: string[] = []): string {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';

  // If it's not a URL, return as-is.
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '').replace(/^\/+/, '');
    if (!path) return '';

    // Take the last path segment (e.g. /@MrBeast → @MrBeast, /shroud → shroud).
    const segments = path.split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : '';
  } catch {
    return trimmed;
  }
}
