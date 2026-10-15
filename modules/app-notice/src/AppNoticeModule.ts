import { NativeModule, requireOptionalNativeModule } from "expo";

// Typed binding for modules/app-notice: the app's own notifications (Android only).

declare class AppNoticeNativeModule extends NativeModule {
  /** "A new version is ready"; a tap opens `url`. False when notifications are off for the app. */
  showUpdateNotice(title: string, text: string, channelName: string, url: string): boolean;
  cancelUpdateNotice(): void;
}

/** Null on iOS and web, and in Android builds from before the module (2026-10-15): JS updates reach those too. */
export default requireOptionalNativeModule<AppNoticeNativeModule>("AppNotice");
