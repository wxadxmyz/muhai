package com.muhai.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
    private var _backWebView: android.webkit.WebView? = null

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
            if (result != "true") { super.onBackPressed() }
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
  }
}
