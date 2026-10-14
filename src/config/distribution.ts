import { extraString } from "./extra";

/**
 * How this build reaches phones, from app.config.js (DISTRIBUTION): `store` for App Store / Google Play, which allow
 * no self-installed updates, no other app store and no tester-only upload (docs/STORE-REVIEW.md); `sideload` for the
 * CI builds testers install with AltStore or as an APK.
 */
export const STORE_BUILD: boolean = extraString("distribution") === "store";

/** The privacy policy (docs/PRIVACY.md) Settings links to; null when the build names none. */
export const PRIVACY_POLICY_URL: string | null = extraString("privacyPolicyUrl");

/**
 * The policy in the app's language: the Ukrainian one sits beside the English one, as docs/PRIVACY.uk.md on GitHub
 * and privacy.uk.html on the website (.github/workflows/pages.yml). Any other address is kept as it is.
 */
export function privacyPolicyUrl(language: string, url: string | null = PRIVACY_POLICY_URL): string | null {
  if (!url || language !== "uk") return url;
  return url.replace(/\/PRIVACY\.md$/, "/PRIVACY.uk.md").replace(/\/privacy\.html$/, "/privacy.uk.html");
}
