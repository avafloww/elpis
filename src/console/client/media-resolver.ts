import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';

/** Resolves a resident Console media route to a browser-safe URL. */
export interface ConsoleMediaResolver {
  resolve(route: string): Promise<string | null>;
}

export const ConsoleMediaResolverContext = createContext<
  ConsoleMediaResolver | undefined
>(undefined);

/**
 * Standalone Console keeps using its same-origin routes. An embedding transport
 * can instead resolve them asynchronously (for example to verified blob URLs).
 */
export function useConsoleMediaUrl(route: string | null): string | null {
  const resolver = useContext(ConsoleMediaResolverContext);
  const [resolved, setResolved] = useState<string | null>(() =>
    resolver ? null : route,
  );

  useEffect(() => {
    let current = true;
    if (!route) {
      setResolved(null);
      return () => {
        current = false;
      };
    }
    if (!resolver) {
      setResolved(route);
      return () => {
        current = false;
      };
    }
    setResolved(null);
    void resolver.resolve(route).then(
      (url) => {
        if (current) setResolved(url);
      },
      () => {
        if (current) setResolved(null);
      },
    );
    return () => {
      current = false;
    };
  }, [resolver, route]);

  return resolved;
}
