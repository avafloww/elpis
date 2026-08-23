export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isNearBottom(metrics: ScrollMetrics, threshold = 24): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold
  );
}

export function preservePrependScrollTop(
  previousTop: number,
  previousHeight: number,
  nextHeight: number,
): number {
  return previousTop + Math.max(0, nextHeight - previousHeight);
}

export function clampLogRailHeight(
  height: number,
  viewportHeight: number,
): number {
  const maximum = Math.max(120, viewportHeight - 240);
  return Math.max(96, Math.min(maximum, height));
}
