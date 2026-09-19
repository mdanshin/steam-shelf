const STORAGE_KEY = 'steam-shelf:min-reviews';

export function normalizeMinReviews(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function filterByReviewCount(games, minimum) {
  const count = normalizeMinReviews(minimum);
  if (count === 0) return games;
  return games.filter((game) => Number.isSafeInteger(game.reviewCount) && game.reviewCount >= count);
}

// Both clients remember this non-sensitive preference on the device. Storage
// may be unavailable, so filtering must also work without persistence.
export function setupReviewCountFilter(input, onChange) {
  let minimum = 0;
  try { minimum = normalizeMinReviews(localStorage.getItem(STORAGE_KEY)); } catch { /* ignore */ }
  input.value = String(minimum);
  input.addEventListener('input', () => {
    if (!input.validity.valid) return;
    minimum = normalizeMinReviews(input.value);
    try { localStorage.setItem(STORAGE_KEY, String(minimum)); } catch { /* ignore */ }
    onChange(minimum);
  });
  // Restore the last valid value after an invalid or unfinished edit.
  input.addEventListener('change', () => { input.value = String(minimum); });
  return minimum;
}
