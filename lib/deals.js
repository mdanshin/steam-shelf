export async function loadDeals() {
  try {
    const module = await import(`../data/deals-data.js?loaded=${Date.now()}`);
    return { games: module.dealsCatalog || [], syncedAt: module.dealsSyncedAt || null, audit: module.dealsAudit || null };
  } catch {
    return { games: [], syncedAt: null, audit: null };
  }
}
