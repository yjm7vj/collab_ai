/**
 * The huddleai.org page.
 *
 * It is the landing surface and nothing else: no identity, no room list, no
 * socket. Someone at the apex cannot be signed in — that is the point of a
 * waitlist — so booting the app shell there would only mean fetching an auth
 * config to decide between two gates neither of which this page shows.
 */
import { useEffect } from "react";

import { LandingPage } from "./landing";
import { useTheme } from "./theme";

const TITLE = "Huddle.AI | Join the waitlist";

export function WaitlistApp() {
  const { theme, toggleTheme } = useTheme();

  // index.html is shared with the app, whose title names a workspace nobody at
  // this address can open yet.
  useEffect(() => {
    document.title = TITLE;
  }, []);

  return (
    <LandingPage
      cta={{ kind: "waitlist" }}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
}
