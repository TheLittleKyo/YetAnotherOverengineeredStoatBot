/**
 * Puppeteer browser manager — singleton instance, launched on first use.
 *
 * Used by providers that need to bypass Cloudflare's JS challenge (Pomf.TV).
 *
 * The browser is launched once and kept alive for the bot's lifetime. Each
 * provider request opens a new page, navigates, extracts data, then closes
 * the page (the browser stays open for reuse).
 *
 * On graceful shutdown, call closeBrowser() to clean up.
 */

import type { Browser, Page } from 'puppeteer';
import { env } from '../config.js';

let browserInstance: Browser | null = null;
let launchPromise: Promise<Browser | null> | null = null;

/**
 * Get the singleton browser instance. Launches on first call.
 * Returns null if Puppeteer couldn't launch (e.g. missing system deps).
 */
export async function getBrowser(): Promise<Browser | null> {
  // If already launching, wait for that.
  if (launchPromise) return launchPromise;
  // If already launched, reuse.
  if (browserInstance) return browserInstance;

  launchPromise = launchBrowser();
  const browser = await launchPromise;
  launchPromise = null;
  browserInstance = browser;
  return browser;
}

async function launchBrowser(): Promise<Browser | null> {
  try {
    // Dynamic import — keeps puppeteer out of the main bundle if not needed.
    const puppeteer = await import('puppeteer');

    // The Chromium sandbox is a key security boundary — this browser navigates
    // attacker-influenced pages (e.g. Pomf.TV scrape targets). Keep it ON by
    // default; only disable when the deployment can't grant it (e.g. running as
    // root in a minimal container) by setting PUPPETEER_NO_SANDBOX=1.
    const disableSandbox = env.puppeteerNoSandbox;
    const args = [
      '--disable-dev-shm-usage', // fixes Docker / low-memory issues
      '--disable-gpu',
      '--window-size=1280,720',
      // Hide the headless-automation signal (navigator.webdriver etc.) so
      // Cloudflare's JS challenge (Pomf.TV) clears instead of looping on the
      // "Just a moment..." interstitial.
      '--disable-blink-features=AutomationControlled',
    ];
    if (disableSandbox) {
      console.warn('[browser] PUPPETEER_NO_SANDBOX=1 — launching Chromium WITHOUT the sandbox. Only use this in an isolated container.');
      args.push('--no-sandbox', '--disable-setuid-sandbox');
    }

    const browser = await puppeteer.default.launch({
      headless: true,
      args,
    });

    // Clean up if the browser crashes/disconnects.
    browser.on('disconnected', () => {
      console.warn('[browser] Puppeteer browser disconnected. Will relaunch on next use.');
      browserInstance = null;
    });

    console.log('[browser] Puppeteer browser launched (Chromium).');
    return browser;
  } catch (error: any) {
    console.warn(`[browser] Could not launch Puppeteer: ${error?.message || error}`);
    console.warn('[browser] Pomf.TV notifications will not work. Install Chromium deps: sudo apt install libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2');
    return null;
  }
}

/**
 * Close the browser instance. Called on graceful shutdown.
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
      console.log('[browser] Puppeteer browser closed.');
    } catch (error: any) {
      console.warn(`[browser] Error closing browser: ${error?.message || error}`);
    }
    browserInstance = null;
  }
}

/**
 * Open a new page, navigate to a URL, wait for network idle (Cloudflare
 * challenge resolves), and return the page. Caller must close the page.
 *
 * Returns null if the browser isn't available or navigation failed.
 */
export async function openPage(url: string, options: { timeoutMs?: number; waitForSelector?: string } = {}): Promise<Page | null> {
  const browser = await getBrowser();
  if (!browser) return null;

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: options.timeoutMs ?? 30000,
    });

    // If a selector is specified, wait for it to appear (confirms Cloudflare passed).
    if (options.waitForSelector) {
      await page.waitForSelector(options.waitForSelector, { timeout: options.timeoutMs ?? 30000 }).catch(() => {});
    }

    return page;
  } catch (error: any) {
    console.warn(`[browser] Navigation to ${url} failed: ${error?.message || error}`);
    return null;
  }
}
