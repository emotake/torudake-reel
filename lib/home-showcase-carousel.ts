export const HOME_SHOWCASE_SLIDE_COUNT = 3;

export function clampHomeShowcaseIndex(index: number, count = HOME_SHOWCASE_SLIDE_COUNT) {
  if (!Number.isInteger(count) || count < 1) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

export function homeShowcaseIndexForKey(
  key: string,
  currentIndex: number,
  count = HOME_SHOWCASE_SLIDE_COUNT,
) {
  if (!Number.isInteger(count) || count < 1) return null;
  if (key === "ArrowRight") return clampHomeShowcaseIndex(currentIndex + 1, count);
  if (key === "ArrowLeft") return clampHomeShowcaseIndex(currentIndex - 1, count);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function nearestHomeShowcaseIndex(
  scrollLeft: number,
  slideOffsets: readonly number[],
) {
  if (slideOffsets.length === 0 || !Number.isFinite(scrollLeft)) return 0;
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [index, offset] of slideOffsets.entries()) {
    if (!Number.isFinite(offset)) continue;
    const distance = Math.abs(offset - scrollLeft);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}
