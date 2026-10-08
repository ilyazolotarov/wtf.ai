import { Platform } from "react-native";

/**
 * What wtf.ai stands for, shown on the splash and the first onboarding page. The same in every language. iOS gets a
 * clean variant so a future App Store review doesn't flag it (Guideline 1.1, objectionable content).
 */
export const TAGLINE = Platform.OS === "ios" ? "Where the funk am I?" : "Where the f* am I?";
