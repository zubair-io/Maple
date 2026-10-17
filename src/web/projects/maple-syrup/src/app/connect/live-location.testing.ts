// A browser-faithful `location`/`history` pair: `replaceState` rewrites the
// same URL that `pathname`/`search`/`hash` read from, as in a real window.
export function liveBrowserUrl(initial: string): {
  location: Pick<Location, 'pathname' | 'hash' | 'search'>;
  history: Pick<History, 'replaceState'>;
} {
  let current = new URL(initial, 'https://mapleeditor.com');
  const replaceState = (_state: unknown, _unused: string, url?: string | URL | null): void => {
    if (url) current = new URL(url, current);
  };
  return {
    location: {
      get pathname() {
        return current.pathname;
      },
      get search() {
        return current.search;
      },
      get hash() {
        return current.hash;
      },
    },
    history: { replaceState },
  };
}
