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
