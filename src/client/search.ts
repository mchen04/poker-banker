import { useEffect, useState } from 'react';

export function useDebouncedSearch(value: string) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), 250);
    return () => window.clearTimeout(timer);
  }, [value]);
  return settled;
}
