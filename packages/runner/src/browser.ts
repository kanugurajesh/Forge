import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// tsx/esbuild's keepNames wraps functions in __name(); define it in-page so page.evaluate bodies run.
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((f) => f);";

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export async function launch(opts: { headless?: boolean; cookies?: { name: string; value: string; url: string }[] } = {}): Promise<Session> {
  const headless = opts.headless ?? true;
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless });
  } catch {
    browser = await chromium.launch({ headless, channel: "chrome" });
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript({ content: NAME_SHIM });
  if (opts.cookies?.length) await context.addCookies(opts.cookies);
  const page = await context.newPage();
  return { browser, context, page, close: () => browser.close() };
}
