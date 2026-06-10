// Shared chromium launcher for the card-realm scripts: playwright's own
// browser when installed (the usual dev setup, same as the other verify
// scripts), else the npm-bundled @sparticuz/chromium build — for sandboxes
// where playwright's browser CDN is unreachable.
import { chromium } from 'playwright';

export async function launchChromium(opts = {}) {
  try {
    return await chromium.launch(opts);
  } catch {
    const sp = (await import('@sparticuz/chromium')).default;
    return chromium.launch({
      ...opts,
      executablePath: await sp.executablePath(),
      args: [...sp.args, ...(opts.args ?? [])],
    });
  }
}
