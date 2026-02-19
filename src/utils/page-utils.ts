/**
 * Page utilities for extracting responses from NotebookLM web UI
 *
 * This module provides functions to:
 * - Extract latest assistant responses from the page
 * - Wait for new responses with streaming detection
 * - Detect placeholders and loading states
 * - Snapshot existing responses for comparison
 *
 * Based on the Python implementation from page_utils.py
 */

import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "patchright";
import type { SourceReference } from "../types.js";
import {
  browserErrorMessage,
  isRecoverableBrowserError,
} from "./browser-errors.js";
import { log } from "./logger.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * CSS selectors to find assistant response elements
 * Ordered by priority (most specific first)
 */
const RESPONSE_SELECTORS = [
  ".to-user-container .message-text-content",
  "[data-message-author='bot']",
  "[data-message-author='assistant']",
  "[data-message-role='assistant']",
  "[data-author='assistant']",
  "[data-renderer*='assistant']",
  "[data-automation-id='response-text']",
  "[data-automation-id='assistant-response']",
  "[data-automation-id='chat-response']",
  "[data-testid*='assistant']",
  "[data-testid*='response']",
  "[aria-live='polite']",
  "[role='listitem'][data-message-author]",
];

const MIN_POLL_INTERVAL_MS = 100;
const POLL_GUARD_MULTIPLIER = 5;
const MIN_POLL_GUARD = 120;
const FAST_POLL_DRIFT_THRESHOLD_MS = 50;
const MAX_FAST_POLL_STREAK = 5;
const HEALTH_CHECK_INTERVAL_POLLS = 10;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const MAX_EXTRACTED_SOURCES = 30;


// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Simple string hash function (for efficient comparison)
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isLikelySameAnswer(candidate: string, expected: string): boolean {
  const a = normalizeText(candidate);
  const b = normalizeText(expected);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 80 && b.length >= 80) {
    return a.includes(b) || b.includes(a);
  }
  return false;
}

function throwIfRecoverableBrowserError(error: unknown, context: string): void {
  if (isRecoverableBrowserError(error)) {
    throw new Error(`${context}: ${browserErrorMessage(error)}`);
  }
}

async function assertPageResponsive(page: Page, timeoutMs: number): Promise<void> {
  const timeoutPromise = delay(timeoutMs).then(() => {
    throw new Error(`health check timed out after ${timeoutMs}ms`);
  });

  try {
    await Promise.race([page.evaluate(() => true), timeoutPromise]);
  } catch (error) {
    throw new Error(`Browser page unresponsive: ${browserErrorMessage(error)}`);
  }
}

async function waitForPollInterval(
  page: Page,
  pollIntervalMs: number,
  fastPollStreakRef: { value: number },
  debug: boolean
): Promise<void> {
  const startedAt = Date.now();
  try {
    await page.waitForTimeout(pollIntervalMs);
  } catch (error) {
    throwIfRecoverableBrowserError(error, "Browser page unavailable during poll wait");
    throw error;
  }

  const waitedMs = Date.now() - startedAt;
  const remainingMs = pollIntervalMs - waitedMs;

  if (remainingMs > FAST_POLL_DRIFT_THRESHOLD_MS) {
    fastPollStreakRef.value++;
    if (debug) {
      log.warning(
        `⚠️ [DEBUG] Poll wait returned early (${waitedMs}ms < ${pollIntervalMs}ms), using fallback sleep`
      );
    }
    await delay(remainingMs);
    return;
  }

  fastPollStreakRef.value = 0;
}

async function extractSourcesFromContainer(container: any): Promise<SourceReference[]> {
  const extracted = await container.evaluate((node: any) => {
    const root = node;
    const unique = new Set<string>();
    const refs: Array<{ title: string; url?: string; raw_text: string }> = [];

    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const stripCitationPrefix = (value: string): string =>
      value.replace(/^\s*\d+\s*[:.)-]\s*/, "").trim();
    const isNumericOnly = (value: string): boolean => /^\d+$/.test(value);
    const isNoiseLabel = (value: string): boolean => {
      const normalized = value.toLowerCase().trim();
      if (!normalized) return true;
      if (/^[.…·•]+$/.test(normalized)) return true;
      if (/^(citation details|click to open citation details)$/.test(normalized)) return true;
      if (/^(show|hide)\s+(additional\s+)?citations?$/.test(normalized)) return true;
      if (/^(show|hide)\s+more\s+citations?$/.test(normalized)) return true;
      if (/^more\s+citations?$/.test(normalized)) return true;
      return false;
    };

    const addRef = (title: string, url?: string, rawText?: string): void => {
      const normalizedTitle = stripCitationPrefix(normalize(title || ""));
      const normalizedRaw = normalize(rawText || normalizedTitle || "");
      const normalizedUrl = normalize(url || "");

      if (!normalizedTitle && !normalizedUrl) {
        return;
      }
      if (!normalizedUrl && (isNoiseLabel(normalizedTitle) || isNumericOnly(normalizedTitle))) {
        return;
      }

      const key = `${normalizedTitle.toLowerCase()}|${normalizedUrl.toLowerCase()}`;
      if (unique.has(key)) {
        return;
      }
      unique.add(key);

      refs.push({
        title: normalizedTitle || normalizedUrl || "Untitled source",
        ...(normalizedUrl ? { url: normalizedUrl } : {}),
        raw_text: normalizedRaw || normalizedTitle || normalizedUrl,
      });
    };

    root.querySelectorAll("a[href]").forEach((anchor: any) => {
      const href = anchor.href || anchor.getAttribute("href") || "";
      const text = anchor.innerText || anchor.textContent || "";
      if (!href) {
        return;
      }
      if (!/^https?:/i.test(href)) {
        return;
      }
      addRef(text || href, href, text || href);
    });

    root.querySelectorAll(".citation-marker, button[dialoglabel*='Citation'], button[triggerdescription*='citation']").forEach((marker: any) => {
      const labelCandidates: string[] = [];

      const pushCandidate = (value?: string | null): void => {
        const normalized = normalize(String(value || ""));
        if (!normalized || isNoiseLabel(normalized)) {
          return;
        }
        labelCandidates.push(normalized);
      };

      pushCandidate(marker.getAttribute?.("aria-label"));
      pushCandidate(marker.getAttribute?.("title"));
      pushCandidate(marker.getAttribute?.("dialoglabel"));
      pushCandidate(marker.getAttribute?.("triggerdescription"));
      pushCandidate(marker.innerText || marker.textContent);

      marker
        .querySelectorAll?.("[aria-label], [title]")
        .forEach((child: any) => {
          pushCandidate(child.getAttribute?.("aria-label"));
          pushCandidate(child.getAttribute?.("title"));
        });

      for (const candidate of labelCandidates) {
        const cleanedTitle = stripCitationPrefix(candidate);
        if (cleanedTitle && !isNoiseLabel(cleanedTitle) && !isNumericOnly(cleanedTitle)) {
          addRef(cleanedTitle, undefined, candidate);
        }
      }
    });

    const sourceLikeSelectors = [
      "[data-testid*='source']",
      "[data-testid*='citation']",
      "[data-automation-id*='source']",
      "[data-automation-id*='citation']",
      "[aria-label*='Source']",
      "[aria-label*='source']",
      "[title*='Source']",
      "[title*='source']",
      ".source-chip",
      ".citation-chip",
      ".source-item",
      ".citation-item",
      ".citation-marker",
      "button[dialoglabel*='Citation']",
      "button[triggerdescription*='citation']",
    ];

    for (const selector of sourceLikeSelectors) {
      root.querySelectorAll(selector).forEach((el: any) => {
        if (el.tagName.toLowerCase() === "a") {
          return;
        }
        const text = el.innerText || el.textContent || "";
        const cleaned = normalize(text || "");
        if (!cleaned) {
          return;
        }
        addRef(cleaned, undefined, cleaned);
      });
    }

    return refs.slice(0, 30);
  });

  if (!Array.isArray(extracted)) {
    return [];
  }

  return extracted
    .map((source) => ({
      title: normalizeText(String(source.title || "")),
      ...(source.url ? { url: normalizeText(String(source.url)) } : {}),
      raw_text: normalizeText(String(source.raw_text || source.title || "")),
    }))
    .filter((source) => source.title.length > 0)
    .slice(0, MAX_EXTRACTED_SOURCES);
}

async function findResponseContainerForAnswer(
  page: Page,
  answer: string
): Promise<any | null> {
  const containers = await page.$$(".to-user-container");
  for (let idx = containers.length - 1; idx >= 0; idx--) {
    const container = containers[idx];
    try {
      const textElement = await container.$(".message-text-content");
      if (!textElement) {
        continue;
      }

      const text = await textElement.innerText();
      if (!text || !text.trim()) {
        continue;
      }

      if (isLikelySameAnswer(text, answer)) {
        return container;
      }
    } catch (error) {
      throwIfRecoverableBrowserError(
        error,
        "Browser page unavailable while matching answer container for source extraction"
      );
      continue;
    }
  }

  return null;
}

async function extractSourcesForAnswer(
  page: Page,
  answer: string,
  debug: boolean
): Promise<SourceReference[]> {
  try {
    const container = await findResponseContainerForAnswer(page, answer);
    if (!container) {
      if (debug) {
        log.dim("🔎 [SOURCES] No matching response container found");
      }
      return [];
    }

    const sources = await extractSourcesFromContainer(container);
    if (debug) {
      log.debug(`🔎 [SOURCES] Extracted ${sources.length} source reference(s)`);
    }
    return sources;
  } catch (error) {
    throwIfRecoverableBrowserError(
      error,
      "Browser page unavailable while extracting sources from answer container"
    );
    if (debug) {
      log.warning(`⚠️ [SOURCES] Failed to extract sources: ${browserErrorMessage(error)}`);
    }
    return [];
  }
}


// ============================================================================
// Main Functions
// ============================================================================

/**
 * Snapshot the latest response text currently visible
 * Returns null if no response found
 */
export async function snapshotLatestResponse(page: Page): Promise<string | null> {
  return await extractLatestText(page, new Set(), false, 0);
}

/**
 * Snapshot ALL existing assistant response texts
 * Used to capture visible responses BEFORE submitting a new question
 */
export async function snapshotAllResponses(page: Page): Promise<string[]> {
  const allTexts: string[] = [];
  const primarySelector = ".to-user-container";

  try {
    const containers = await page.$$(primarySelector);
    if (containers.length > 0) {
      for (const container of containers) {
        try {
          const textElement = await container.$(".message-text-content");
          if (textElement) {
            const text = await textElement.innerText();
            if (text && text.trim()) {
              allTexts.push(text.trim());
            }
          }
        } catch {
          continue;
        }
      }

      log.info(`📸 [SNAPSHOT] Captured ${allTexts.length} existing responses`);
    }
  } catch (error) {
    log.warning(`⚠️ [SNAPSHOT] Failed to snapshot responses: ${error}`);
  }

  return allTexts;
}

/**
 * Count the number of visible assistant response elements
 */
export async function countResponseElements(page: Page): Promise<number> {
  let count = 0;
  for (const selector of RESPONSE_SELECTORS) {
    try {
      const elements = await page.$$(selector);
      if (elements.length > 0) {
        // Count only visible elements
        for (const el of elements) {
          try {
            const isVisible = await el.isVisible();
            if (isVisible) {
              count++;
            }
          } catch {
            continue;
          }
        }
        // If we found elements with this selector, stop trying others
        if (count > 0) {
          break;
        }
      }
    } catch {
      continue;
    }
  }
  return count;
}

/**
 * Wait for a new assistant response with streaming detection
 *
 * This function:
 * 1. Polls the page for new response text
 * 2. Detects streaming (text changes) vs. complete (text stable)
 * 3. Requires text to be stable for 3 consecutive polls before returning
 * 4. Ignores placeholders, question echoes, and known responses
 *
 * @param page Playwright page instance
 * @param options Options for waiting
 * @returns The new response text, or null if timeout
 */
export async function waitForLatestAnswer(
  page: Page,
  options: {
    question?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    ignoreTexts?: string[];
    debug?: boolean;
  } = {}
): Promise<string | null> {
  const {
    question = "",
    timeoutMs = 120000,
    pollIntervalMs = 1000,
    ignoreTexts = [],
    debug = false,
  } = options;

  const safePollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, pollIntervalMs);
  const expectedPolls = Math.ceil(timeoutMs / safePollIntervalMs);
  const maxPolls = Math.max(MIN_POLL_GUARD, expectedPolls * POLL_GUARD_MULTIPLIER);
  const deadline = Date.now() + timeoutMs;
  const sanitizedQuestion = question.trim().toLowerCase();

  // Track ALL known texts as HASHES (memory efficient!)
  const knownHashes = new Set<number>();
  for (const text of ignoreTexts) {
    if (typeof text === "string" && text.trim()) {
      knownHashes.add(hashString(text.trim()));
    }
  }

  if (debug) {
    log.debug(
      `🔍 [DEBUG] Waiting for NEW answer. Ignoring ${knownHashes.size} known responses`
    );
  }

  let pollCount = 0;
  let lastCandidate: string | null = null;
  let stableCount = 0; // Track how many times we see the same text
  const requiredStablePolls = 3; // Text must be stable for 3 consecutive polls
  const fastPollStreakRef = { value: 0 };

  while (Date.now() < deadline && pollCount < maxPolls) {
    pollCount++;

    if (pollCount % HEALTH_CHECK_INTERVAL_POLLS === 0) {
      await assertPageResponsive(page, HEALTH_CHECK_TIMEOUT_MS);
    }

    // Check if NotebookLM is still "thinking" (most reliable indicator)
    try {
      const thinkingElement = await page.$('div.thinking-message');
      if (thinkingElement) {
        const isVisible = await thinkingElement.isVisible();
        if (isVisible) {
          if (debug && pollCount % 5 === 0) {
            log.debug("🔍 [DEBUG] NotebookLM still thinking (div.thinking-message visible)...");
          }
          await waitForPollInterval(
            page,
            safePollIntervalMs,
            fastPollStreakRef,
            debug
          );
          continue;
        }
      }
    } catch (error) {
      throwIfRecoverableBrowserError(
        error,
        "Browser page unavailable while checking thinking indicator"
      );
      // Ignore errors checking thinking state
    }

    // Extract latest NEW text
    const candidate = await extractLatestText(page, knownHashes, debug, pollCount);

    if (candidate) {
      const normalized = candidate.trim();
      if (normalized) {
        const lower = normalized.toLowerCase();

        // Check if it's the question echo
        if (lower === sanitizedQuestion) {
          if (debug) {
            log.debug("🔍 [DEBUG] Found question echo, ignoring");
          }
          knownHashes.add(hashString(normalized)); // Mark as seen
          await waitForPollInterval(
            page,
            safePollIntervalMs,
            fastPollStreakRef,
            debug
          );
          continue;
        }

        // ========================================
        // STREAMING DETECTION: Check if text is stable
        // ========================================
        if (normalized === lastCandidate) {
          // Text hasn't changed - it's stable
          stableCount++;
          if (debug && stableCount === requiredStablePolls) {
            log.debug(
              `✅ [DEBUG] Text stable for ${stableCount} polls (${normalized.length} chars)`
            );
          }
        } else {
          // Text changed - streaming in progress
          if (debug && lastCandidate) {
            log.debug(
              `🔄 [DEBUG] Text changed (${normalized.length} chars, was ${lastCandidate.length})`
            );
          }
          stableCount = 1;
          lastCandidate = normalized;
        }

        // Only return once text is stable
        if (stableCount >= requiredStablePolls) {
          if (debug) {
            log.debug(`✅ [DEBUG] Returning stable answer (${normalized.length} chars)`);
          }
          return normalized;
        }
      }
    }

    await waitForPollInterval(page, safePollIntervalMs, fastPollStreakRef, debug);

    if (fastPollStreakRef.value >= MAX_FAST_POLL_STREAK) {
      await assertPageResponsive(page, HEALTH_CHECK_TIMEOUT_MS);
      fastPollStreakRef.value = 0;
    }
  }

  if (pollCount >= maxPolls && Date.now() < deadline) {
    throw new Error(
      `Polling guard triggered after ${pollCount} polls before timeout; browser page may be unresponsive`
    );
  }

  if (debug) {
    log.debug(`⏱️ [DEBUG] Timeout after ${pollCount} polls`);
  }
  return null;
}

/**
 * Wait for the latest answer and parse source/citation elements from the matched
 * response container in the DOM.
 */
export async function waitForLatestAnswerWithSources(
  page: Page,
  options: {
    question?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    ignoreTexts?: string[];
    debug?: boolean;
  } = {}
): Promise<{ answer: string | null; sources: SourceReference[] }> {
  const answer = await waitForLatestAnswer(page, options);
  if (!answer) {
    return { answer: null, sources: [] };
  }

  const sources = await extractSourcesForAnswer(page, answer, options.debug === true);
  return { answer, sources };
}

/**
 * Extract the latest NEW response text from the page
 * Uses hash-based comparison for efficiency
 *
 * @param page Playwright page instance
 * @param knownHashes Set of hashes of already-seen response texts
 * @param debug Enable debug logging
 * @param pollCount Current poll number (for conditional logging)
 * @returns First NEW response text found, or null
 */
async function extractLatestText(
  page: Page,
  knownHashes: Set<number>,
  debug: boolean,
  pollCount: number
): Promise<string | null> {
  // Try the primary selector first (most specific for NotebookLM)
  const primarySelector = ".to-user-container";
  try {
    const containers = await page.$$(primarySelector);
    const totalContainers = containers.length;

    // Early exit if no new containers possible
    if (totalContainers <= knownHashes.size) {
      if (debug && pollCount % 5 === 0) {
        log.dim(
          `⏭️ [EXTRACT] No new containers (${totalContainers} total, ${knownHashes.size} known)`
        );
      }
      return null;
    }

    if (containers.length > 0) {
      // Only log every 5th poll to reduce noise
      if (debug && pollCount % 5 === 0) {
        log.dim(
          `🔍 [EXTRACT] Scanning ${totalContainers} containers (${knownHashes.size} known)`
        );
      }

      let skipped = 0;
      let empty = 0;

      // Scan ALL containers to find the FIRST with NEW text
      for (let idx = 0; idx < containers.length; idx++) {
        const container = containers[idx];
        try {
          const textElement = await container.$(".message-text-content");
          if (textElement) {
            const text = await textElement.innerText();
            if (text && text.trim()) {
              // Hash-based comparison (faster & less memory)
              const textHash = hashString(text.trim());
              if (!knownHashes.has(textHash)) {
                log.success(
                  `✅ [EXTRACT] Found NEW text in container[${idx}]: ${text.trim().length} chars`
                );
                return text.trim();
              } else {
                skipped++;
              }
            } else {
              empty++;
            }
          }
        } catch (error) {
          throwIfRecoverableBrowserError(
            error,
            "Browser page unavailable while reading response container"
          );
          continue;
        }
      }

      // Only log summary if debug enabled
      if (debug && pollCount % 5 === 0) {
        log.dim(
          `⏭️ [EXTRACT] No NEW text (skipped ${skipped} known, ${empty} empty)`
        );
      }
      return null; // Don't fall through to fallback!
    } else {
      if (debug) {
        log.warning("⚠️ [EXTRACT] No containers found");
      }
    }
  } catch (error) {
    throwIfRecoverableBrowserError(error, "Browser page unavailable in primary extraction");
    log.error(`❌ [EXTRACT] Primary selector failed: ${error}`);
  }

  // Fallback: Try other selectors (only if primary selector failed/found nothing)
  if (debug) {
    log.dim("🔄 [EXTRACT] Trying fallback selectors...");
  }

  for (const selector of RESPONSE_SELECTORS) {
    try {
      const elements = await page.$$(selector);
      if (elements.length === 0) continue;

      // Scan ALL elements to find the first with NEW text
      for (const element of elements) {
        try {
          // Prefer full container text when available
          let container = element;
          try {
            const closest = await element.evaluateHandle((el) => {
              return el.closest(
                "[data-message-author], [data-message-role], [data-author], " +
                  "[data-testid*='assistant'], [data-automation-id*='response'], article, section"
              );
            });
            if (closest) {
              container = closest.asElement() || element;
            }
          } catch (error) {
            throwIfRecoverableBrowserError(
              error,
              "Browser page unavailable while resolving response container"
            );
            container = element;
          }

          const text = await container.innerText();
          if (text && text.trim() && !knownHashes.has(hashString(text.trim()))) {
            return text.trim();
          }
        } catch (error) {
          throwIfRecoverableBrowserError(
            error,
            "Browser page unavailable while reading fallback response element"
          );
          continue;
        }
      }
    } catch (error) {
      throwIfRecoverableBrowserError(
        error,
        `Browser page unavailable while querying fallback selector (${selector})`
      );
      continue;
    }
  }

  // Final fallback: JavaScript evaluation
  try {
    const fallbackText = await page.evaluate((): string | null => {
      // @ts-expect-error - DOM types available in browser context
      const unique = new Set<Element>();
      // @ts-expect-error - DOM types available in browser context
      const isVisible = (el: Element): boolean => {
        // @ts-expect-error - DOM types available in browser context
        if (!el || !(el as HTMLElement).isConnected) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        // @ts-expect-error - window available in browser context
        const style = window.getComputedStyle(el as HTMLElement);
        if (
          style.visibility === "hidden" ||
          style.display === "none" ||
          parseFloat(style.opacity || "1") === 0
        ) {
          return false;
        }
        return true;
      };

      const selectors = [
        "[data-message-author]",
        "[data-message-role]",
        "[data-author]",
        "[data-renderer*='assistant']",
        "[data-testid*='assistant']",
        "[data-automation-id*='response']",
      ];

      const candidates: string[] = [];
      for (const selector of selectors) {
        // @ts-expect-error - document available in browser context
        for (const el of document.querySelectorAll(selector)) {
          if (!isVisible(el)) continue;
          if (unique.has(el)) continue;
          unique.add(el);

          // @ts-expect-error - DOM types available in browser context
          const text = (el as HTMLElement).innerText || (el as HTMLElement).textContent || "";
          if (!text.trim()) continue;

          candidates.push(text.trim());
        }
      }

      if (candidates.length > 0) {
        return candidates[candidates.length - 1];
      }

      return null;
    });

    if (typeof fallbackText === "string" && fallbackText.trim()) {
      return fallbackText.trim();
    }
  } catch (error) {
    throwIfRecoverableBrowserError(error, "Browser page unavailable during JS fallback extraction");
    // Ignore evaluation errors
  }

  return null;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  snapshotLatestResponse,
  snapshotAllResponses,
  countResponseElements,
  waitForLatestAnswer,
  waitForLatestAnswerWithSources,
};
