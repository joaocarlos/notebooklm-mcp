/**
 * Shared browser error helpers.
 *
 * These patterns cover common Playwright/Patchright failures for closed,
 * disconnected, crashed, or unresponsive browser/page/context states.
 */

const RECOVERABLE_BROWSER_ERROR_PATTERN =
  /has been closed|Target .* closed|Browser has been closed|Context .* closed|Target page, context or browser has been closed|Target page, context or browser has been disconnected|Browser closed|Browser disconnected|Page crashed|page crashed|Protocol error|Execution context was destroyed|Session closed|unresponsive|health check timed out/i;

export function browserErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

export function isRecoverableBrowserError(error: unknown): boolean {
  return RECOVERABLE_BROWSER_ERROR_PATTERN.test(browserErrorMessage(error));
}
