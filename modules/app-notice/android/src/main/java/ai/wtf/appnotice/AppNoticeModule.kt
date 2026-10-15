package ai.wtf.appnotice

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The app's own notifications (docs/UPDATES-SPEC.md §5.3): posted by the app itself, no push server. Android only.

class AppNoticeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppNotice")

    // "A new version is ready" (UpdateNotice): false when notifications are off for the app.
    Function("showUpdateNotice") { title: String, text: String, channelName: String, url: String ->
      val context = appContext.reactContext ?: return@Function false
      UpdateNotice.show(context, title, text, channelName, url)
    }

    Function("cancelUpdateNotice") {
      appContext.reactContext?.let { UpdateNotice.cancel(it) }
      Unit
    }
  }
}
