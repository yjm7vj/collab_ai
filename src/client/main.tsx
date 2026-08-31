import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isWaitlistHost } from "./host";
import { WaitlistApp } from "./waitlist";
import "./styles.css";

// One bundle, two hostnames: the apex is the waitlist, everything else is the
// app. See src/client/host.ts.
createRoot(document.getElementById("root")!).render(
  <StrictMode>{isWaitlistHost() ? <WaitlistApp /> : <App />}</StrictMode>,
);
