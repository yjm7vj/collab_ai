/**
 * Light/dark state, shared by the app shell and the standalone waitlist page.
 *
 * It lives outside App because the waitlist page is a separate entry point —
 * it renders the same landing surface with none of the app's identity, room or
 * socket machinery — and both have to write the same `data-theme` attribute and
 * the same stored key, or a visitor's choice would not survive moving between
 * huddleai.org and app.huddleai.org.
 */
import { useCallback, useEffect, useState } from "react";

import type { ThemeMode } from "./components";

const THEME_KEY = "collab_ai:theme";

function storedTheme(): ThemeMode {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

export function useTheme(): { theme: ThemeMode; toggleTheme: () => void } {
  const [theme, setTheme] = useState<ThemeMode>(storedTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "light" ? "dark" : "light"));
  }, []);

  return { theme, toggleTheme };
}
