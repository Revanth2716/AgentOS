import fs from 'node:fs';

export interface BrowserAvailability {
  available: boolean;
  reason?: string;
  executable?: string;
}

type PlaywrightModule = typeof import('playwright');
type Browser = import('playwright').Browser;
type Page = import('playwright').Page;

/**
 * Lazily loads Playwright and launches Chromium on first use. Playwright is an
 * OPTIONAL dependency — when it (or the Chromium binary) is missing, every
 * browser tool fails with an actionable message and the rest of AgentOS keeps
 * working. Chromium is never downloaded implicitly.
 */
export class BrowserManager {
  private mod: PlaywrightModule | null = null;
  private browser: Browser | null = null;
  private readonly pages = new Map<string, Page>();
  private availability: BrowserAvailability | null = null;

  async availabilityProbe(): Promise<BrowserAvailability> {
    if (this.availability) return this.availability;
    try {
      this.mod = await import('playwright');
      const executable = this.mod.chromium.executablePath();
      if (!fs.existsSync(executable)) {
        this.availability = {
          available: false,
          reason: 'Chromium is not installed — run: npm run setup:browser',
          executable,
        };
        return this.availability;
      }
      this.availability = { available: true, executable };
    } catch (e) {
      this.availability = {
        available: false,
        reason: `playwright not installed (${(e as Error).message}) — run: npm i playwright && npm run setup:browser`,
      };
    }
    return this.availability;
  }

  async pageFor(runId: string): Promise<Page> {
    const probe = await this.availabilityProbe();
    if (!probe.available || !this.mod) throw new Error(probe.reason ?? 'browser unavailable');
    if (!this.browser) {
      this.browser = await this.mod.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
    }
    let page = this.pages.get(runId);
    if (!page || page.isClosed()) {
      page = await this.browser.newPage();
      page.setDefaultTimeout(15_000);
      this.pages.set(runId, page);
    }
    return page;
  }

  async closeRun(runId: string): Promise<void> {
    const page = this.pages.get(runId);
    this.pages.delete(runId);
    if (page && !page.isClosed()) await page.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pages.keys()].map((id) => this.closeRun(id)));
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }
}

let shared: BrowserManager | null = null;

/** Process-wide singleton (one Chromium for all runs). */
export function getBrowserManager(): BrowserManager {
  if (!shared) shared = new BrowserManager();
  return shared;
}
