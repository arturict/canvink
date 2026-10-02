package app.canvink.android

import android.content.ClipData
import android.content.Intent
import android.os.Build
import android.util.Base64
import android.view.HapticFeedbackConstants
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import java.io.File

/**
 * What the page may ask of the phone (window.CanvinkAndroid, typed in
 * src/mobile/nativeBridge.ts): haptics, back handling, the bar insets and
 * colours, the share sheet and the end of the splash screen. Nothing here
 * reads or sends the person's data on its own; a share only opens the system
 * sheet with what the page passed, and the person picks the destination.
 * Only Canvink's own page is loaded in this WebView; links open in the browser.
 */
class CanvinkBridge(private val activity: MainActivity) {
  @JavascriptInterface
  fun haptic(kind: String) {
    val constant = when (kind) {
      "confirm" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
      "reject" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
      "long" -> HapticFeedbackConstants.LONG_PRESS
      else -> HapticFeedbackConstants.CLOCK_TICK
    }
    activity.performHaptic(constant)
  }

  @JavascriptInterface
  fun setBackEnabled(enabled: Boolean) {
    activity.setBackEnabled(enabled)
  }

  @JavascriptInterface
  fun insets(): String = activity.currentInsets()

  @JavascriptInterface
  fun setSystemBars(lightBackground: Boolean) {
    activity.setSystemBarsLight(lightBackground)
  }

  @JavascriptInterface
  fun ready() {
    activity.markReady()
  }

  /** Start-up and page-open times (src/mobile/metrics.ts), for `adb logcat -s Canvink`. */
  @JavascriptInterface
  fun metric(name: String, milliseconds: Double) {
    val sinceProcessStart = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      android.os.SystemClock.elapsedRealtime() - android.os.Process.getStartElapsedRealtime()
    } else {
      -1L
    }
    android.util.Log.i("Canvink", "metric ${name.take(40)}=${milliseconds.toLong()}ms processAge=${sinceProcessStart}ms")
  }

  @JavascriptInterface
  fun shareText(subject: String, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
      type = "text/plain"
      putExtra(Intent.EXTRA_SUBJECT, subject)
      putExtra(Intent.EXTRA_TEXT, text)
    }
    activity.runOnUiThread { activity.startActivity(Intent.createChooser(send, subject)) }
  }

  @JavascriptInterface
  fun shareFile(base64: String, mimeType: String, fileName: String, subject: String) {
    // Only a plain file name inside the app's own share folder in its cache.
    val safeName = fileName.replace(Regex("[^\\p{L}\\p{N}._ -]"), "-").take(120).ifBlank { "canvink" }
    val folder = File(activity.cacheDir, "shared").apply { mkdirs() }
    folder.listFiles()?.forEach { it.delete() }
    val file = File(folder, safeName)
    file.writeBytes(Base64.decode(base64, Base64.DEFAULT))
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
      type = mimeType
      putExtra(Intent.EXTRA_STREAM, uri)
      putExtra(Intent.EXTRA_SUBJECT, subject)
      clipData = ClipData.newRawUri(safeName, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.runOnUiThread { activity.startActivity(Intent.createChooser(send, subject)) }
  }
}
