export function createCatalogLifecycle() {
  const catalogs = new Map();
  let personalRevision = 0;
  return {
    catalogs,
    revision: () => personalRevision,
    invalidatePersonal() {
      personalRevision += 1;
      catalogs.delete('library');
      catalogs.delete('wishlist');
    },
    canStore(view, revision) {
      return view === 'deals' || revision === personalRevision;
    },
    canRender(requestedView, currentView) {
      return requestedView === currentView;
    },
  };
}
