import { NativeModule, requireOptionalNativeModule } from "expo";

// Typed binding for modules/app-notice: the app's own notifications (Android), and on iOS where the app came from.

declare class AppNoticeNativeModule extends NativeModule {
  /** Android: "A new version is ready"; a tap opens `url`. False when notifications are off for the app. */
  showUpdateNotice(title: string, text: string, channelName: string, url: string): boolean;
  /** Android. */
  cancelUpdateNotice(): void;
  /** iOS: this copy was installed by TestFlight, not the App Store (StoreKit's sandbox environment). */
  installedFromTestFlight?(): Promise<boolean>;
}

/**
 * Null on web, in Android builds from before the module (2026-10-15) and in iOS builds from before its iOS half
 * (2026-11-12): JS updates reach those too.
 */
export default requireOptionalNativeModule<AppNoticeNativeModule>("AppNotice");
