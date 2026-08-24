package com.muhai.app

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.content.pm.ActivityInfo
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
    private var _backWebView: android.webkit.WebView? = null
    private var _bridgeAttached = false

    // JS 桥：前端通过 window.MuHaiAndroid.setOrientation('landscape'|'portrait'|'auto')
    // 调用原生强制横/竖屏。原因：部分 ROM/WebView 对 HTML5 requestFullscreen 与
    // screen.orientation.lock 支持差（点击无反应），只能走原生 requestedOrientation。
    private class OrientationBridge(private val activity: MainActivity) {
        @JavascriptInterface
        fun setOrientation(mode: String) {
            val o = when (mode) {
                "landscape" -> ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
                "portrait" -> ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
                else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
            activity.runOnUiThread { activity.requestedOrientation = o }
        }
    }

    // 把 JS 桥挂到 WebView（WebView 由 Tauri 创建，需等其就绪后再注入）。
    private fun attachBridge() {
        if (_bridgeAttached) return
        val wv = _backWebView ?: findBackWebView(window?.decorView as? android.view.ViewGroup)
        _backWebView = wv
        if (wv != null) {
            wv.addJavascriptInterface(OrientationBridge(this), "MuHaiAndroid")
            _bridgeAttached = true
        }
    }

    override fun onResume() {
        super.onResume()
        attachBridge()
    }

    override fun onBackPressed() {
        val wv = _backWebView ?: findBackWebView(window?.decorView as? android.view.ViewGroup)
        _backWebView = wv
        if (wv == null) {
            super.onBackPressed()
            return
        }
        wv.evaluateJavascript(
            "(function(){ try { return window.__onAndroidBack ? !!window.__onAndroidBack() : true; } catch(e) { return true; } })()"
        ) { result ->
            // 问题 #8 修复：逻辑写反修正。
            // JS 返回 true  = "已无更内层，请执行系统返回"（退到主页/退出）
            // JS 返回 false = "我已逐级退了一层，别走系统返回"（留在当前层）
            if (result == "true") { super.onBackPressed() }
        }
    }

    private fun findBackWebView(group: android.view.ViewGroup?): android.webkit.WebView? {
        if (group == null) return null
        for (i in 0 until group.childCount) {
            val child = group.getChildAt(i)
            if (child is android.webkit.WebView) return child
            if (child is android.view.ViewGroup) {
                val found = findBackWebView(child)
                if (found != null) return found
            }
        }
        return null
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 问题 #9 修复：底部系统手势条透明化，跟随 App 主题背景（白显白、黑显黑）。
    window.navigationBarColor = android.graphics.Color.TRANSPARENT
    // Android 12+：关闭系统自动加的对比度条，否则仍会强制显示灰条。
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
      window.isNavigationBarContrastEnforced = false
    }
    attachBridge()
  }
}
