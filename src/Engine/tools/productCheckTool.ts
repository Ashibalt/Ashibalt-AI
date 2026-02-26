import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../../logger';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditIssue {
  type: string;
  severity: 'high' | 'medium' | 'low';
  element: string;
  detail: string;
  element2?: string;
  container?: string;
  rect?: any;
  src?: string;
  children_count?: number;
}

interface AuditResult {
  success: boolean;
  summary: {
    viewport: { width: number; height: number };
    documentHeight: number;
    totalElements: number;
    totalIssues: number;
    byType: Record<string, number>;
    bySeverity: { high: number; medium: number; low: number };
  };
  issues: AuditIssue[];
  timestamp: string;
}

interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
  line?: number;
}

interface NetworkFailure {
  url: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  error?: string;
}

interface ViewportReport {
  viewport: string;
  width: number;
  audit: AuditResult;
  consoleErrors: ConsoleEntry[];
  networkFailures: NetworkFailure[];
}

interface ProductCheckResult {
  success: boolean;
  url: string;
  title?: string;
  reports: ViewportReport[];
  formatted: string;
  totalIssues: number;
  duration_ms: number;
}

// ─── Chrome / Edge Detection ──────────────────────────────────────────────────

/**
 * Finds a Chrome or Edge executable on the current system.
 * Searches common installation paths by platform.
 */
function findBrowser(): string | null {
  const platform = process.platform;

  const candidates: string[] = [];

  if (platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';

    candidates.push(
      // Edge (comes first — more common on Windows, especially user preference)
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      // Chrome
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Chromium
      path.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    // Linux
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/snap/bin/chromium',
    );
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found, try next
    }
  }

  return null;
}

// ─── Audit Script Loader ──────────────────────────────────────────────────────

/**
 * Loads the page-audit.js script that gets injected into pages.
 * Looks relative to the extension root (resources/js/page-audit.js).
 */
function loadAuditScript(): string {
  // Try multiple potential locations
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'resources', 'js', 'page-audit.js'),
    path.join(__dirname, '..', '..', 'resources', 'js', 'page-audit.js'),
    path.join(__dirname, '..', 'resources', 'js', 'page-audit.js'),
  ];

  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf-8');
    } catch {
      // try next
    }
  }

  throw new Error(
    'Could not find page-audit.js script. Expected at resources/js/page-audit.js relative to extension root.'
  );
}

// ─── Viewport Presets ─────────────────────────────────────────────────────────

const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};

// ─── Main Tool Implementation ─────────────────────────────────────────────────

/**
 * product_check tool — Headless QA engine for web pages.
 *
 * Launches a headless browser (Chrome/Edge), navigates to the specified URL,
 * runs comprehensive layout/visual/interaction/accessibility checks, and returns
 * a plain-text report that any model can understand (no vision required).
 *
 * @param args Tool arguments:
 *   - url (string, required): URL to check (must be http/https)
 *   - viewport (string, optional): "mobile", "tablet", "desktop", "responsive", or "WxH" (default: "desktop")
 *   - checks (string[], optional): Specific checks to run. Default: all.
 *     Options: "viewport", "overlap", "interactions", "alignment", "images", "accessibility", "console"
 *   - wait_ms (number, optional): Wait time after page load before running checks (default: 2000)
 */
export async function productCheckTool(args: any): Promise<ProductCheckResult> {
  const startTime = Date.now();

  // ── Validate args ──────────────────────────────────────────────────────

  if (!args || typeof args.url !== 'string') {
    return {
      success: false,
      url: args?.url || '',
      reports: [],
      formatted: 'ERROR: product_check requires "url" parameter (string).',
      totalIssues: 0,
      duration_ms: 0,
    };
  }

  const urlStr = args.url;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlStr);
  } catch {
    return {
      success: false,
      url: urlStr,
      reports: [],
      formatted: `ERROR: Invalid URL "${urlStr}". Must be a full URL like http://localhost:3000`,
      totalIssues: 0,
      duration_ms: 0,
    };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return {
      success: false,
      url: urlStr,
      reports: [],
      formatted: `ERROR: Only HTTP/HTTPS URLs are supported. Got: ${parsedUrl.protocol}`,
      totalIssues: 0,
      duration_ms: 0,
    };
  }

  // ── Determine viewports ────────────────────────────────────────────────

  const viewportArg = (args.viewport || 'desktop').toLowerCase();
  const viewportsToCheck: { name: string; width: number; height: number }[] = [];

  if (viewportArg === 'responsive') {
    viewportsToCheck.push(
      { name: 'mobile (375px)', ...VIEWPORT_PRESETS.mobile },
      { name: 'tablet (768px)', ...VIEWPORT_PRESETS.tablet },
      { name: 'desktop (1440px)', ...VIEWPORT_PRESETS.desktop },
    );
  } else if (VIEWPORT_PRESETS[viewportArg]) {
    viewportsToCheck.push({ name: `${viewportArg} (${VIEWPORT_PRESETS[viewportArg].width}px)`, ...VIEWPORT_PRESETS[viewportArg] });
  } else {
    // Try parsing "WxH" format
    const match = viewportArg.match(/^(\d+)x(\d+)$/);
    if (match) {
      viewportsToCheck.push({ name: `${match[1]}×${match[2]}`, width: parseInt(match[1]), height: parseInt(match[2]) });
    } else {
      viewportsToCheck.push({ name: 'desktop (1440px)', ...VIEWPORT_PRESETS.desktop });
    }
  }

  // ── Determine which checks to run ──────────────────────────────────────

  const allChecks = ['viewport', 'overlap', 'interactions', 'alignment', 'images', 'accessibility'];
  const requestedChecks: string[] = Array.isArray(args.checks)
    ? args.checks.map((c: string) => c.toLowerCase())
    : allChecks;

  const checkOptions = {
    checkViewport: requestedChecks.includes('viewport'),
    checkOverlap: requestedChecks.includes('overlap'),
    checkInteractions: requestedChecks.includes('interactions'),
    checkAlignment: requestedChecks.includes('alignment'),
    checkImages: requestedChecks.includes('images'),
    checkAccessibility: requestedChecks.includes('accessibility'),
  };

  const waitMs = Math.min(Math.max(args.wait_ms || 2000, 500), 15000);

  // ── Find browser ───────────────────────────────────────────────────────

  const browserPath = findBrowser();
  if (!browserPath) {
    return {
      success: false,
      url: urlStr,
      reports: [],
      formatted: [
        'ERROR: No Chrome, Edge, or Chromium browser found on this system.',
        '',
        'product_check requires a Chromium-based browser. Install one of:',
        '  • Google Chrome: https://google.com/chrome',
        '  • Microsoft Edge: https://microsoft.com/edge',
        '',
        process.platform === 'win32'
          ? 'Searched: Program Files, Program Files (x86), LocalAppData'
          : process.platform === 'darwin'
            ? 'Searched: /Applications/'
            : 'Searched: /usr/bin/, /snap/bin/',
      ].join('\n'),
      totalIssues: 0,
      duration_ms: Date.now() - startTime,
    };
  }

  logger.log(`[PRODUCT_CHECK] Browser found: ${browserPath}`);
  logger.log(`[PRODUCT_CHECK] URL: ${urlStr}, viewports: ${viewportsToCheck.map((v) => v.name).join(', ')}`);

  // Auto-open the URL in the system default browser.
  // This ensures dev servers (Vite, CRA, etc.) are awake and responsive before
  // puppeteer navigates. Without this, a user who hasn't manually opened the page
  // gets a timeout or empty DOM because the app hasn't hydrated yet.
  try {
    await vscode.env.openExternal(vscode.Uri.parse(urlStr));
    // Give browser + server a moment to establish connection before headless audit
    await new Promise((r) => setTimeout(r, 1500));
    logger.log(`[PRODUCT_CHECK] Opened URL in default browser`);
  } catch (e) {
    logger.log(`[PRODUCT_CHECK] Could not auto-open browser (non-fatal): ${e}`);
  }

  // ── Load puppeteer-core ────────────────────────────────────────────────

  let puppeteer: any;
  try {
    puppeteer = require('puppeteer-core');
  } catch {
    return {
      success: false,
      url: urlStr,
      reports: [],
      formatted: [
        'ERROR: puppeteer-core is not installed.',
        '',
        'Run this command to install it:',
        '  npm install puppeteer-core',
        '',
        'puppeteer-core is a lightweight (~2MB) library that controls Chrome/Edge.',
        'Unlike full puppeteer, it does NOT download a bundled browser.',
      ].join('\n'),
      totalIssues: 0,
      duration_ms: Date.now() - startTime,
    };
  }

  // ── Load audit script ──────────────────────────────────────────────────

  let auditScript: string;
  try {
    auditScript = loadAuditScript();
  } catch (err: any) {
    return {
      success: false,
      url: urlStr,
      reports: [],
      formatted: `ERROR: ${err.message}`,
      totalIssues: 0,
      duration_ms: Date.now() - startTime,
    };
  }

  // ── Launch browser & run checks ────────────────────────────────────────

  let browser: any = null;
  const reports: ViewportReport[] = [];

  try {
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      timeout: 20000,
    });

    const page = await browser.newPage();

    // Set up console error and network failure collection (persists across viewports)
    let consoleErrors: ConsoleEntry[] = [];
    let networkFailures: NetworkFailure[] = [];

    page.on('console', (msg: any) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        const loc = msg.location();
        consoleErrors.push({
          level: type,
          text: msg.text().slice(0, 500),
          url: loc?.url,
          line: loc?.lineNumber,
        });
      }
    });

    page.on('pageerror', (err: any) => {
      consoleErrors.push({
        level: 'exception',
        text: (err.message || String(err)).slice(0, 500),
      });
    });

    page.on('requestfailed', (req: any) => {
      const failure = req.failure();
      networkFailures.push({
        url: req.url().slice(0, 300),
        resourceType: req.resourceType(),
        error: failure?.errorText || 'unknown',
      });
    });

    page.on('response', (res: any) => {
      const status = res.status();
      if (status >= 400) {
        networkFailures.push({
          url: res.url().slice(0, 300),
          status,
          statusText: res.statusText(),
          resourceType: res.request().resourceType(),
        });
      }
    });

    // ── Run checks at each viewport ────────────────────────────────────

    for (const vp of viewportsToCheck) {
      // Reset collectors for each viewport
      consoleErrors = [];
      networkFailures = [];

      logger.log(`[PRODUCT_CHECK] Setting viewport: ${vp.name} (${vp.width}×${vp.height})`);
      await page.setViewport({ width: vp.width, height: vp.height });

      // Navigate (re-navigate for each viewport to see responsive behavior).
      // Use 'domcontentloaded' — NOT 'networkidle2': dev servers (Vite, webpack-dev-server)
      // keep persistent WebSocket connections for HMR that never go idle, causing a 30s timeout.
      // SPA hydration is covered by the waitMs delay below.
      try {
        await page.goto(urlStr, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
      } catch (navErr: any) {
        reports.push({
          viewport: vp.name,
          width: vp.width,
          audit: {
            success: false,
            summary: {
              viewport: { width: vp.width, height: vp.height },
              documentHeight: 0,
              totalElements: 0,
              totalIssues: 0,
              byType: {},
              bySeverity: { high: 0, medium: 0, low: 0 },
            },
            issues: [],
            timestamp: new Date().toISOString(),
          },
          consoleErrors: [{
            level: 'exception',
            text: `Navigation failed: ${navErr.message || String(navErr)}`,
          }],
          networkFailures: [],
        });
        continue;
      }

      // Wait for any async rendering (SPA hydration, animations, etc.)
      await page.evaluate((ms: number) => new Promise((r) => setTimeout(r, ms)), waitMs);

      // Inject and run audit script
      const auditResult: AuditResult = await page.evaluate(`
        ${auditScript}
        runPageAudit(${JSON.stringify(checkOptions)});
      `);

      // Get page title
      const pageTitle = await page.title();

      reports.push({
        viewport: vp.name,
        width: vp.width,
        audit: auditResult,
        consoleErrors: [...consoleErrors],
        networkFailures: [...networkFailures],
      });

      logger.log(
        `[PRODUCT_CHECK] ${vp.name}: ${auditResult.summary.totalIssues} audit issues, ${consoleErrors.length} console errors, ${networkFailures.length} network failures`
      );
    }

    await browser.close();
    browser = null;

    // ── Format the report ──────────────────────────────────────────────

    const totalIssues = reports.reduce(
      (sum, r) => sum + r.audit.issues.length + r.consoleErrors.length + r.networkFailures.length,
      0
    );

    const formatted = formatReport(urlStr, reports, totalIssues);
    const duration = Date.now() - startTime;

    logger.log(`[PRODUCT_CHECK] Complete in ${duration}ms: ${totalIssues} total issues`);

    return {
      success: true,
      url: urlStr,
      title: reports[0]?.audit ? await getPageTitle(reports) : undefined,
      reports,
      formatted,
      totalIssues,
      duration_ms: duration,
    };
  } catch (err: any) {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }

    const duration = Date.now() - startTime;
    return {
      success: false,
      url: urlStr,
      reports,
      formatted: `ERROR running product_check: ${err.message || String(err)}`,
      totalIssues: 0,
      duration_ms: duration,
    };
  }
}

// ─── Helper: Extract page title from reports ─────────────────────────────────

function getPageTitle(reports: ViewportReport[]): string | undefined {
  // title is not stored in audit — return undefined for now
  return undefined;
}

// ─── Report Formatter ─────────────────────────────────────────────────────────

/**
 * Formats the audit report as a readable text document.
 * This is what the model sees — it must be clear, actionable, and well-structured.
 */
function formatReport(url: string, reports: ViewportReport[], totalIssues: number): string {
  const lines: string[] = [];

  lines.push(`PRODUCT CHECK REPORT`);
  lines.push(`URL: ${url}`);
  lines.push(`Checked at: ${new Date().toISOString()}`);
  lines.push(`Viewports tested: ${reports.map((r) => r.viewport).join(', ')}`);
  lines.push('');

  if (totalIssues === 0) {
    lines.push('✅ NO ISSUES FOUND — the page looks clean across all checked viewports.');
    lines.push('');
    for (const report of reports) {
      lines.push(`  ${report.viewport}: ${report.audit.summary.totalElements} elements checked, 0 issues.`);
    }
    return lines.join('\n');
  }

  // ── Overall summary ──────────────────────────────────────────────────

  const totalHigh = reports.reduce((s, r) => s + r.audit.summary.bySeverity.high, 0);
  const totalMedium = reports.reduce((s, r) => s + r.audit.summary.bySeverity.medium, 0);
  const totalLow = reports.reduce((s, r) => s + r.audit.summary.bySeverity.low, 0);
  const totalConsole = reports.reduce((s, r) => s + r.consoleErrors.length, 0);
  const totalNetwork = reports.reduce((s, r) => s + r.networkFailures.length, 0);

  lines.push(`SUMMARY: ${totalIssues} issues found`);
  lines.push(`  🔴 High:   ${totalHigh}`);
  lines.push(`  🟡 Medium: ${totalMedium}`);
  lines.push(`  ⚪ Low:    ${totalLow}`);
  if (totalConsole > 0) lines.push(`  💥 Console errors: ${totalConsole}`);
  if (totalNetwork > 0) lines.push(`  🔗 Network failures: ${totalNetwork}`);
  lines.push('');

  // ── Per-viewport details ─────────────────────────────────────────────

  for (const report of reports) {
    const vpIssues = report.audit.issues.length + report.consoleErrors.length + report.networkFailures.length;
    lines.push(`VIEWPORT: ${report.viewport}  (${report.audit.summary.totalElements} elements, ${vpIssues} issues)`);

    if (vpIssues === 0) {
      lines.push('  No issues at this viewport.');
      lines.push('');
      continue;
    }

    // Group issues by type for readability
    const grouped: Record<string, AuditIssue[]> = {};
    for (const issue of report.audit.issues) {
      if (!grouped[issue.type]) grouped[issue.type] = [];
      grouped[issue.type].push(issue);
    }

    // Sort: high severity types first
    const typeOrder = Object.keys(grouped).sort((a, b) => {
      const aHigh = grouped[a].filter((i) => i.severity === 'high').length;
      const bHigh = grouped[b].filter((i) => i.severity === 'high').length;
      return bHigh - aHigh;
    });

    for (const type of typeOrder) {
      const issues = grouped[type];
      const label = TYPE_LABELS[type] || type;
      lines.push('');
      lines.push(`  ▸ ${label} (${issues.length})`);

      // Show up to 10 issues per type (avoid flooding)
      const shown = issues.slice(0, 10);
      for (const issue of shown) {
        const sev = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '⚪';
        lines.push(`    ${sev} ${issue.detail}`);
        lines.push(`       Element: ${issue.element}`);
        if (issue.element2) lines.push(`       Overlaps: ${issue.element2}`);
        if (issue.container) lines.push(`       In: ${issue.container}`);
      }

      if (issues.length > 10) {
        lines.push(`    ... and ${issues.length - 10} more.`);
      }
    }

    // Console errors
    if (report.consoleErrors.length > 0) {
      lines.push('');
      lines.push(`  ▸ Console Errors (${report.consoleErrors.length})`);
      const shown = report.consoleErrors.slice(0, 8);
      for (const err of shown) {
        const prefix = err.level === 'exception' ? '💥' : err.level === 'error' ? '🔴' : '🟡';
        lines.push(`    ${prefix} [${err.level}] ${err.text}`);
        if (err.url) lines.push(`       Source: ${err.url}${err.line ? `:${err.line}` : ''}`);
      }
      if (report.consoleErrors.length > 8) {
        lines.push(`    ... and ${report.consoleErrors.length - 8} more.`);
      }
    }

    // Network failures
    if (report.networkFailures.length > 0) {
      lines.push('');
      lines.push(`  ▸ Network Failures (${report.networkFailures.length})`);
      const shown = report.networkFailures.slice(0, 8);
      for (const nf of shown) {
        if (nf.status) {
          lines.push(`    🔗 [${nf.status}] ${nf.url} (${nf.resourceType || 'unknown'})`);
        } else {
          lines.push(`    🔗 ${nf.error || 'failed'}: ${nf.url} (${nf.resourceType || 'unknown'})`);
        }
      }
      if (report.networkFailures.length > 8) {
        lines.push(`    ... and ${report.networkFailures.length - 8} more.`);
      }
    }

    lines.push('');
  }

  // ── Actionable recommendations ───────────────────────────────────────

  lines.push(`RECOMMENDED ACTIONS (prioritized)`);

  const allIssues = reports.flatMap((r) => r.audit.issues);
  const highIssues = allIssues.filter((i) => i.severity === 'high');
  const hasNetworkFails = reports.some((r) => r.networkFailures.length > 0);
  const hasConsoleErrors = reports.some((r) => r.consoleErrors.length > 0);

  let actionNum = 1;

  if (highIssues.some((i) => i.type === 'horizontal_scroll' || i.type === 'viewport_overflow')) {
    lines.push(`${actionNum}. Fix viewport overflow — elements extend beyond the screen edge, causing horizontal scroll.`);
    lines.push(`   Look for fixed widths, missing max-width, or padding/margin issues.`);
    actionNum++;
  }

  if (highIssues.some((i) => i.type === 'covered_interactive')) {
    lines.push(`${actionNum}. Fix covered interactive elements — some buttons/links are blocked by overlapping elements.`);
    lines.push(`   Check z-index stacking and positioning of overlapping containers.`);
    actionNum++;
  }

  if (highIssues.some((i) => i.type === 'sibling_overlap')) {
    lines.push(`${actionNum}. Fix layout overlaps — sibling elements are overlapping each other.`);
    lines.push(`   This usually indicates missing height, broken flex/grid layout, or negative margins.`);
    actionNum++;
  }

  if (highIssues.some((i) => i.type === 'broken_image')) {
    lines.push(`${actionNum}. Fix broken images — some <img> tags failed to load their source.`);
    lines.push(`   Check image URLs, verify files exist, and ensure the server is serving them.`);
    actionNum++;
  }

  if (hasConsoleErrors) {
    lines.push(`${actionNum}. Fix JavaScript errors — the console shows errors during page load.`);
    lines.push(`   These can cause broken functionality and visual glitches.`);
    actionNum++;
  }

  if (hasNetworkFails) {
    lines.push(`${actionNum}. Fix network failures — some resources returned HTTP 4xx/5xx or failed to load.`);
    actionNum++;
  }

  if (allIssues.some((i) => i.type === 'text_clipped')) {
    lines.push(`${actionNum}. Fix clipped text — some text content is being cut off by overflow:hidden.`);
    lines.push(`   Add text-overflow:ellipsis or increase container size.`);
    actionNum++;
  }

  if (allIssues.some((i) => i.type === 'missing_alt' || i.type === 'missing_label')) {
    lines.push(`${actionNum}. Improve accessibility — missing alt attributes on images and/or labels on form inputs.`);
    actionNum++;
  }

  if (actionNum === 1) {
    lines.push('  Only low-severity issues found. Address them when convenient.');
  }

  return lines.join('\n');
}

// ─── Issue Type Labels ────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  viewport_overflow: 'Viewport Overflow',
  horizontal_scroll: 'Horizontal Scroll',
  sibling_overlap: 'Sibling Overlap',
  covered_interactive: 'Covered Interactive Element',
  dead_interaction: 'Dead Interaction',
  empty_button: 'Empty Button',
  dead_link: 'Dead Link',
  inconsistent_sizing: 'Inconsistent Sizing',
  misalignment: 'Misalignment',
  broken_image: 'Broken Image',
  missing_alt: 'Missing Alt Text',
  image_distortion: 'Image Distortion',
  accessibility: 'Accessibility',
  missing_label: 'Missing Form Label',
  small_tap_target: 'Small Tap Target',
  heading_skip: 'Heading Level Skip',
  text_clipped: 'Text Clipped',
  duplicate_id: 'Duplicate ID',
  fixed_out_of_viewport: 'Fixed Element Out of Viewport',
  empty_link: 'Empty Link',
};
