/**
 * page-audit.js — Self-contained page audit script.
 * Injected into a web page via puppeteer's page.evaluate().
 * Returns a structured JSON report of visual/layout/interaction/accessibility issues.
 *
 * Design principles:
 * - Minimize false positives (only flag HIGH/MEDIUM confidence issues)
 * - Check only VISIBLE elements
 * - All output is plain text — no screenshots, no vision model needed
 */

// eslint-disable-next-line no-unused-vars
function runPageAudit(options = {}) {
  const {
    checkOverlap = true,
    checkViewport = true,
    checkAccessibility = true,
    checkImages = true,
    checkInteractions = true,
    checkAlignment = true,
    checkConsole = false, // console errors collected externally
  } = options;

  const issues = [];
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const documentH = document.documentElement.scrollHeight;

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Check if element is truly visible.
   */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  /**
   * Get a concise selector for an element (for reporting).
   */
  function describeEl(el) {
    if (!el) return '(null)';
    let desc = el.tagName.toLowerCase();
    if (el.id) desc += `#${el.id}`;
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).slice(0, 3).join('.');
      if (classes) desc += `.${classes}`;
    }
    // Add text hint for context
    const text = (el.textContent || '').trim().slice(0, 30);
    if (text) desc += ` "${text}${el.textContent.trim().length > 30 ? '…' : ''}"`;
    return desc;
  }

  /**
   * Check if two rects overlap significantly.
   */
  function rectsOverlap(a, b, threshold = 4) {
    const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return overlapX > threshold && overlapY > threshold;
  }

  /**
   * Check if element is in normal document flow (not absolutely/fixed positioned).
   */
  function isInFlow(el) {
    const pos = getComputedStyle(el).position;
    return pos === 'static' || pos === 'relative' || pos === 'sticky';
  }

  // ── Check 1: Viewport Overflow / Bleed ──────────────────────────────────

  if (checkViewport) {
    const allElements = document.querySelectorAll('body *');
    for (const el of allElements) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      // Skip tiny elements (icons, borders, etc.)
      if (rect.width < 10 || rect.height < 10) continue;
      // Skip elements that are scrollable containers themselves
      const style = getComputedStyle(el);
      if (style.overflow === 'auto' || style.overflow === 'scroll') continue;
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;

      // Check horizontal overflow — element extends beyond viewport right edge
      if (rect.right > viewportW + 2) {
        const overflow = Math.round(rect.right - viewportW);
        // Only flag if the overflow is significant
        if (overflow > 5) {
          issues.push({
            type: 'viewport_overflow',
            severity: overflow > 50 ? 'high' : 'medium',
            element: describeEl(el),
            detail: `Element extends ${overflow}px beyond right edge of viewport (${viewportW}px wide).`,
            rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), right: Math.round(rect.right) },
          });
        }
      }

      // Check if element is wider than viewport (causing horizontal scroll)
      if (rect.width > viewportW + 5) {
        issues.push({
          type: 'viewport_overflow',
          severity: 'high',
          element: describeEl(el),
          detail: `Element width (${Math.round(rect.width)}px) exceeds viewport width (${viewportW}px), causing horizontal scroll.`,
        });
      }
    }

    // Check if body/html causes horizontal scrollbar
    if (document.documentElement.scrollWidth > viewportW + 5) {
      issues.push({
        type: 'horizontal_scroll',
        severity: 'high',
        element: 'document',
        detail: `Page has horizontal scrollbar. Document width: ${document.documentElement.scrollWidth}px, viewport: ${viewportW}px.`,
      });
    }
  }

  // ── Check 2: Sibling Overlap Detection ──────────────────────────────────

  if (checkOverlap) {
    // Check siblings within containers — overlapping siblings in normal flow is almost always a bug
    const containers = document.querySelectorAll('body, main, section, article, div, ul, ol, nav, header, footer, form, fieldset, table');
    const checked = new Set();

    for (const container of containers) {
      const children = Array.from(container.children).filter(
        (ch) => isVisible(ch) && isInFlow(ch)
      );
      if (children.length < 2 || children.length > 50) continue; // skip huge containers

      for (let i = 0; i < children.length; i++) {
        for (let j = i + 1; j < children.length; j++) {
          const a = children[i];
          const b = children[j];
          const key = `${a.tagName}${a.className}|${b.tagName}${b.className}`;
          if (checked.has(key)) continue;
          checked.add(key);

          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();

          // Skip tiny elements
          if (ra.width < 10 || ra.height < 10) continue;
          if (rb.width < 10 || rb.height < 10) continue;

          if (rectsOverlap(ra, rb, 8)) {
            const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            const overlapArea = Math.round(overlapX * overlapY);
            const smallerArea = Math.min(ra.width * ra.height, rb.width * rb.height);
            const overlapPct = Math.round((overlapArea / smallerArea) * 100);

            // Only report significant overlaps (>10% of the smaller element)
            if (overlapPct > 10) {
              issues.push({
                type: 'sibling_overlap',
                severity: overlapPct > 40 ? 'high' : 'medium',
                element: describeEl(a),
                element2: describeEl(b),
                detail: `In-flow siblings overlap by ${overlapPct}% (${overlapArea}px² area). This usually indicates a layout bug.`,
                container: describeEl(container),
              });
            }
          }
        }
      }
    }

    // Check if interactive elements are covered by other elements
    const interactiveEls = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [onclick]');
    for (const el of interactiveEls) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) continue;

      // Use elementFromPoint at center of element
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > viewportW || cy > viewportH) continue;

      const topEl = document.elementFromPoint(cx, cy);
      if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
        issues.push({
          type: 'covered_interactive',
          severity: 'high',
          element: describeEl(el),
          detail: `Interactive element is covered by ${describeEl(topEl)} at its center point. Users cannot click it.`,
        });
      }
    }
  }

  // ── Check 3: Dead / Broken Interactions ─────────────────────────────────

  if (checkInteractions) {
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const style = getComputedStyle(btn);

      // Check disabled buttons that look enabled
      if (btn.disabled) continue; // legitimately disabled

      // Check buttons with pointer-events: none (looks clickable but isn't)
      if (style.pointerEvents === 'none') {
        issues.push({
          type: 'dead_interaction',
          severity: 'medium',
          element: describeEl(btn),
          detail: 'Button has pointer-events: none — it looks clickable but will not respond to clicks.',
        });
      }

      // Check empty buttons (no text, no aria-label, no child content)
      const hasText = (btn.textContent || '').trim().length > 0;
      const hasAriaLabel = btn.getAttribute('aria-label') || btn.getAttribute('title');
      const hasImg = btn.querySelector('img, svg, [class*="icon"]');
      if (!hasText && !hasAriaLabel && !hasImg) {
        issues.push({
          type: 'empty_button',
          severity: 'medium',
          element: describeEl(btn),
          detail: 'Button has no text, no aria-label, and no icon. Users and screen readers cannot identify its purpose.',
        });
      }
    }

    // Check links with empty href or javascript:void
    const links = document.querySelectorAll('a');
    for (const link of links) {
      if (!isVisible(link)) continue;
      const href = link.getAttribute('href');
      if (!href || href === '#' || href === 'javascript:void(0)' || href === 'javascript:;') {
        // Only flag if it has no click handler via common patterns
        const hasOnClick = link.hasAttribute('onclick') || link.getAttribute('role') === 'button';
        if (!hasOnClick) {
          issues.push({
            type: 'dead_link',
            severity: 'low',
            element: describeEl(link),
            detail: `Link has href="${href || '(empty)'}" and no onclick handler. It may be non-functional.`,
          });
        }
      }
    }
  }

  // ── Check 4: Alignment & Size Consistency ───────────────────────────────

  if (checkAlignment) {
    // Find "card grids": groups of similar siblings (same tag, similar classes)
    const flexGridContainers = document.querySelectorAll('[class*="grid"], [class*="row"], [class*="cards"], [class*="list"], [class*="items"]');
    const allFlexGrid = new Set(flexGridContainers);

    // Also detect flex/grid containers dynamically
    document.querySelectorAll('div, section, ul, ol, main').forEach((el) => {
      const s = getComputedStyle(el);
      if (s.display === 'flex' || s.display === 'grid' || s.display === 'inline-flex' || s.display === 'inline-grid') {
        allFlexGrid.add(el);
      }
    });

    for (const container of allFlexGrid) {
      const children = Array.from(container.children).filter((ch) => isVisible(ch));
      if (children.length < 3 || children.length > 30) continue;

      // Check: do all flex/grid children in a row have the same height? (common expectation)
      const heights = children.map((ch) => Math.round(ch.getBoundingClientRect().height));
      const avgHeight = heights.reduce((a, b) => a + b, 0) / heights.length;
      if (avgHeight < 20) continue; // too small to matter

      const maxDev = Math.max(...heights.map((h) => Math.abs(h - avgHeight)));
      const devPct = Math.round((maxDev / avgHeight) * 100);

      // Only flag if deviation is significant (>30%) — slight differences are often OK
      if (devPct > 30 && maxDev > 20) {
        const minH = Math.min(...heights);
        const maxH = Math.max(...heights);
        issues.push({
          type: 'inconsistent_sizing',
          severity: devPct > 60 ? 'medium' : 'low',
          element: describeEl(container),
          detail: `Children have inconsistent heights: ${minH}px to ${maxH}px (${devPct}% deviation). Expected uniform sizing in a grid/flex container.`,
          children_count: children.length,
        });
      }

      // Check left-edge alignment: in a vertical list, children should share left edge
      const s = getComputedStyle(container);
      if (s.flexDirection === 'column' || s.display === 'block') {
        const lefts = children.map((ch) => Math.round(ch.getBoundingClientRect().left));
        const uniqueLefts = [...new Set(lefts)];
        if (uniqueLefts.length > 1) {
          const maxMisalign = Math.max(...lefts) - Math.min(...lefts);
          if (maxMisalign > 5 && maxMisalign < 200) {
            issues.push({
              type: 'misalignment',
              severity: maxMisalign > 20 ? 'medium' : 'low',
              element: describeEl(container),
              detail: `Vertical list children have misaligned left edges (${maxMisalign}px spread). Expected aligned left margins.`,
            });
          }
        }
      }
    }
  }

  // ── Check 5: Broken Images & Missing Resources ──────────────────────────

  if (checkImages) {
    const images = document.querySelectorAll('img');
    for (const img of images) {
      if (!isVisible(img)) continue;

      // Check if image failed to load
      if (img.complete && img.naturalWidth === 0 && img.src) {
        issues.push({
          type: 'broken_image',
          severity: 'high',
          element: describeEl(img),
          detail: `Image failed to load: ${img.src.slice(0, 120)}`,
          src: img.src,
        });
      }

      // Check images without alt attribute
      if (!img.hasAttribute('alt')) {
        issues.push({
          type: 'missing_alt',
          severity: 'medium',
          element: describeEl(img),
          detail: 'Image is missing alt attribute. This hurts accessibility and SEO.',
          src: (img.src || '').slice(0, 120),
        });
      }

      // Check for images rendered at wildly wrong aspect ratio
      if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
        const naturalRatio = img.naturalWidth / img.naturalHeight;
        const rect = img.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
          const displayRatio = rect.width / rect.height;
          const distortion = Math.abs(naturalRatio - displayRatio) / naturalRatio;
          if (distortion > 0.15) {
            issues.push({
              type: 'image_distortion',
              severity: distortion > 0.3 ? 'medium' : 'low',
              element: describeEl(img),
              detail: `Image is visually distorted: natural aspect ratio ${naturalRatio.toFixed(2)}, displayed as ${displayRatio.toFixed(2)} (${Math.round(distortion * 100)}% distortion).`,
            });
          }
        }
      }
    }

    // Check background images that might be broken (CSS)
    // We can detect CSS background-image and check via a hidden img load, but this is slow.
    // Skip for MVP — focus on <img> tags.
  }

  // ── Check 6: Accessibility Quick Scan ───────────────────────────────────

  if (checkAccessibility) {
    // Missing lang attribute on html
    if (!document.documentElement.lang) {
      issues.push({
        type: 'accessibility',
        severity: 'medium',
        element: 'html',
        detail: 'The <html> element does not have a "lang" attribute. Screen readers need it to choose the correct voice.',
      });
    }

    // Missing page title
    if (!document.title || document.title.trim().length === 0) {
      issues.push({
        type: 'accessibility',
        severity: 'medium',
        element: 'head > title',
        detail: 'The page has no <title>. This is essential for accessibility and SEO.',
      });
    }

    // Form inputs without labels
    const inputs = document.querySelectorAll('input, select, textarea');
    for (const input of inputs) {
      if (!isVisible(input)) continue;
      if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') continue;

      const hasLabel = input.id && document.querySelector(`label[for="${input.id}"]`);
      const hasAriaLabel = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
      const hasPlaceholder = input.getAttribute('placeholder');
      const wrappedInLabel = input.closest('label');

      if (!hasLabel && !hasAriaLabel && !wrappedInLabel) {
        issues.push({
          type: 'missing_label',
          severity: hasPlaceholder ? 'low' : 'medium',
          element: describeEl(input),
          detail: `Form input has no associated <label>, no aria-label, and is not wrapped in a <label>.${hasPlaceholder ? ' Has placeholder as fallback, but proper labels are preferred.' : ''}`,
        });
      }
    }

    // Small tap targets (< 44x44px as per WCAG 2.5.5)
    const tappable = document.querySelectorAll('button, a, input[type="checkbox"], input[type="radio"], select, [role="button"], [role="tab"], [role="menuitem"]');
    for (const el of tappable) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue; // skip invisible
      if (rect.width < 44 || rect.height < 44) {
        // Only flag if really small — some inline links are expected to be small
        if (rect.width < 24 || rect.height < 24) {
          issues.push({
            type: 'small_tap_target',
            severity: 'low',
            element: describeEl(el),
            detail: `Interactive element is ${Math.round(rect.width)}×${Math.round(rect.height)}px. WCAG recommends at least 44×44px for tap targets.`,
          });
        }
      }
    }

    // Check color contrast for text (simplified)
    // Full contrast checking requires canvas rendering - too heavy for inline check.
    // Instead, flag text on potentially problematic backgrounds.
    // Skip for MVP — this is better handled by dedicated a11y tools.

    // Heading hierarchy check
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let lastLevel = 0;
    for (const h of headings) {
      if (!isVisible(h)) continue;
      const level = parseInt(h.tagName.charAt(1));
      if (level > lastLevel + 1 && lastLevel > 0) {
        issues.push({
          type: 'heading_skip',
          severity: 'low',
          element: describeEl(h),
          detail: `Heading level skips from h${lastLevel} to h${level}. Expected h${lastLevel + 1}. This confuses screen reader navigation.`,
        });
      }
      lastLevel = level;
    }
  }

  // ── Check 7: Text Overflow / Truncation ─────────────────────────────────

  {
    // Find elements where text is clipped without an ellipsis indicator
    const textContainers = document.querySelectorAll('p, span, h1, h2, h3, h4, h5, h6, a, button, label, td, th, li, div');
    for (const el of textContainers) {
      if (!isVisible(el)) continue;
      // Only check leaf-ish elements (those with direct text)
      if (el.children.length > 3) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 5) continue;

      const style = getComputedStyle(el);
      // Check for hidden overflow that clips text
      if (style.overflow === 'hidden' && style.textOverflow !== 'ellipsis') {
        const rect = el.getBoundingClientRect();
        if (el.scrollWidth > rect.width + 5 || el.scrollHeight > rect.height + 5) {
          issues.push({
            type: 'text_clipped',
            severity: 'medium',
            element: describeEl(el),
            detail: `Text is clipped by overflow:hidden without text-overflow:ellipsis. Content: "${text.slice(0, 50)}…". Element: ${Math.round(rect.width)}×${Math.round(rect.height)}px, content: ${el.scrollWidth}×${el.scrollHeight}px.`,
          });
        }
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  const summary = {
    viewport: { width: viewportW, height: viewportH },
    documentHeight: documentH,
    totalElements: document.querySelectorAll('*').length,
    totalIssues: issues.length,
    byType: {},
    bySeverity: { high: 0, medium: 0, low: 0 },
  };

  for (const issue of issues) {
    summary.byType[issue.type] = (summary.byType[issue.type] || 0) + 1;
    summary.bySeverity[issue.severity] = (summary.bySeverity[issue.severity] || 0) + 1;
  }

  return {
    success: true,
    summary,
    issues,
    timestamp: new Date().toISOString(),
  };
}
