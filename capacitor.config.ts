import type { CapacitorConfig } from "@capacitor/cli";
// Online preview wrapper. API keys remain in the hosted server's environment.
// For release, bundle an exported React client and add production mobile auth.
const config: CapacitorConfig = {
  appId: "app.scout.research",
  appName: "Scout",
  webDir: "mobile-shell",
  server: {
    // The site the app opens. Build for your deployment with, for example:
    // SCOUT_APP_URL=https://your-project.vercel.app pnpm exec cap sync android
    url: process.env.SCOUT_APP_URL || "https://scout-web-research.belugaremodeling.chatgpt.site",
    cleartext: false,
  },
  android: {
    backgroundColor: "#171819",
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};
export default config;
