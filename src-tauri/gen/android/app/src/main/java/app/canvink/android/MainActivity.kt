package app.canvink.android

import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewTreeObserver
import android.webkit.WebView
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/**
 * The Canvink phone app around its WebView. The page draws edge to edge under
 * the status and navigation bars and gets their sizes as CSS variables (see
 * src/mobile/nativeBridge.ts); only the keyboard shortens the window, so the
 * caret and the formatting bar stay above it.
 *
 * Back: while the page has a screen or sheet to close it says so through the
 * bridge, and this activity hands the system's back gesture to it, with the
 * gesture's progress on Android 14 and later (predictive back). Otherwise
 * Tauri's own handler leaves the app.
 */
class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var latestInsets = JSONObject()
  private var contentReady = false
  private val readyFallback = Runnable {
    contentReady = true
    findViewById<View>(android.R.id.content).invalidate()
  }

  private val backCallback = object : OnBackPressedCallback(false) {
    override fun handleOnBackStarted(backEvent: BackEventCompat) {
      sendBack("started", backEvent.progress, backEvent.swipeEdge)
    }

    override fun handleOnBackProgressed(backEvent: BackEventCompat) {
      sendBack("progress", backEvent.progress, backEvent.swipeEdge)
    }

    override fun handleOnBackCancelled() {
      sendBack("cancelled", 0f, 0)
    }

    override fun handleOnBackPressed() {
      sendBack("pressed", 1f, 0)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    val night = isNight(resources.configuration)
    // Transparent bars; the icons follow the theme (light paper, dark night).
    enableEdgeToEdge(
      statusBarStyle = if (night) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
      navigationBarStyle = if (night) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // No grey scrim behind the three-button navigation bar: the app draws its own surface there.
      window.isNavigationBarContrastEnforced = false
    }

    val content = findViewById<View>(android.R.id.content)
    // The system splash screen stays until the first screen has painted (or
    // at most 2.5 s), instead of showing an empty page while it loads.
    content.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
      override fun onPreDraw(): Boolean {
        if (!contentReady) return false
        content.viewTreeObserver.removeOnPreDrawListener(this)
        return true
      }
    })
    content.postDelayed(readyFallback, 2500)

    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      val keyboardOpen = insets.isVisible(WindowInsetsCompat.Type.ime()) && keyboard.bottom > bars.bottom
      // Landscape: the navigation bar and a cutout sit at a side; the page keeps clear of them.
      view.setPadding(bars.left, 0, bars.right, if (keyboardOpen) keyboard.bottom else 0)
      val density = resources.displayMetrics.density
      latestInsets = JSONObject()
        .put("top", bars.top / density)
        .put("bottom", if (keyboardOpen) 0f else bars.bottom / density)
        .put("left", 0)
        .put("right", 0)
        .put("keyboard", if (keyboardOpen) keyboard.bottom / density else 0f)
        .put("fontScale", resources.configuration.fontScale.toDouble())
      evaluate("window.__canvinkInsets && window.__canvinkInsets($latestInsets)")
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    // The page's own background until it paints: paper by day, the night surface by night.
    webView.setBackgroundColor(if (isNight(resources.configuration)) Color.parseColor("#121715") else Color.parseColor("#F7F5EF"))
    webView.isHapticFeedbackEnabled = true
    // The WebView would scale every text by the system font size, the text on
    // a page too, which then no longer lines up with the handwriting around it.
    // The shell scales its own text instead (--font-scale, see onApplyWindowInsets).
    webView.settings.textZoom = 100
    webView.addJavascriptInterface(CanvinkBridge(this), "CanvinkAndroid")
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // Font size or dark mode changed while the app was open.
    latestInsets.put("fontScale", newConfig.fontScale.toDouble())
    evaluate("window.__canvinkInsets && window.__canvinkInsets($latestInsets)")
    val night = isNight(newConfig)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !night
      isAppearanceLightNavigationBars = !night
    }
  }

  private fun isNight(configuration: Configuration): Boolean =
    (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  private fun evaluate(script: String) {
    val view = webView ?: return
    view.post { view.evaluateJavascript(script, null) }
  }

  private fun sendBack(phase: String, progress: Float, edge: Int) {
    evaluate("window.__canvinkBack && window.__canvinkBack('$phase', $progress, $edge)")
  }

  internal fun currentInsets(): String = latestInsets.toString()

  internal fun setBackEnabled(enabled: Boolean) {
    runOnUiThread {
      if (enabled) {
        // Registered again so it is the newest callback: it runs before
        // Tauri's own back handler, which is registered when the WebView is.
        backCallback.remove()
        onBackPressedDispatcher.addCallback(this, backCallback)
      }
      backCallback.isEnabled = enabled
    }
  }

  internal fun setSystemBarsLight(light: Boolean) {
    runOnUiThread {
      WindowCompat.getInsetsController(window, window.decorView).apply {
        isAppearanceLightStatusBars = light
        isAppearanceLightNavigationBars = light
      }
    }
  }

  internal fun performHaptic(constant: Int) {
    val view = webView ?: return
    view.post { view.performHapticFeedback(constant) }
  }

  internal fun markReady() {
    runOnUiThread {
      contentReady = true
      findViewById<View>(android.R.id.content).removeCallbacks(readyFallback)
      findViewById<View>(android.R.id.content).invalidate()
    }
  }
}
