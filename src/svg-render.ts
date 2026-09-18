/**
 * SVG → PNG rendering for the welcome cards and captcha images.
 *
 * `new Resvg(...).render()` runs on the main thread, and with system fonts
 * enabled resvg scans every installed font before it draws — 0.7–0.9 s per
 * image on a typical Windows install, during which the bot handles nothing
 * else (a raid of 30 joins froze it for ~25 s). `renderAsync` does the same
 * work on the libuv thread pool instead, so the event loop stays free.
 *
 * The pool is shared with async fs and DNS lookups (every REST call resolves
 * a hostname there), so renders are also capped at two at a time: a join
 * flood queues its images here instead of starving the rest of the bot.
 */
import { renderAsync, type ResvgRenderOptions } from '@resvg/resvg-js';
import { limitConcurrency } from './async-utils.js';

const MAX_CONCURRENT_RENDERS = 2;

export const renderSvgToPngAsync: (svg: string, options: ResvgRenderOptions) => Promise<Buffer> = limitConcurrency(
  MAX_CONCURRENT_RENDERS,
  async (svg: string, options: ResvgRenderOptions) => (await renderAsync(svg, options)).asPng(),
);
