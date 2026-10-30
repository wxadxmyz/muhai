package com.muhai.app

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * V4.1.6 A：网盘登录专用原生 Activity。
 *
 * 背景：之前网盘登录把「主 Tauri WebView」导航到官网登录页，返回时再导航回 tauri.localhost
 * 会整页重载（表现为"重启 App"）；且注入式 DOM 顶栏在桌面 UA 下会横向滑动、被通知栏压。
 *
 * 本 Activity 用「独立 WebView + 原生顶栏」承载登录：
 *  - 主 Tauri WebView 永远不被导航，返回只是 finish 本 Activity，回到网盘登录选择页，不会重载；
 *  - 顶栏（X + 标题）是原生控件，不存在横向滑动/被压问题（C 项）；
 *  - 抓取到的 token 经 JS 桥 NetdiskBridge 上报，关闭时写入结果文件，由 Rust 轮询取回主 App。
 */
class NetdiskLoginActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var titleView: TextView
    private lateinit var handler: Handler

    private var url: String = ""
    private var provider: String = ""
    private var script: String = ""
    private var resultPath: String = ""
    private var capturedToken: String? = null
    private var done: Boolean = false

    private val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        url = intent.getStringExtra("url") ?: ""
        provider = intent.getStringExtra("provider") ?: ""
        script = intent.getStringExtra("script") ?: ""
        resultPath = intent.getStringExtra("result_path") ?: ""

        val density = resources.displayMetrics.density
        val sbh = statusBarHeightPx()

        // ── 根布局 ──
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.MATCH_PARENT
            )
        }

        // ── 原生顶部返回栏（替代注入式 DOM 顶栏）──
        val barH = (sbh + 48 * density).toInt()
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, barH)
            setPadding(0, sbh, 0, 0)
        }

        val back = TextView(this).apply {
            text = "✕"
            textSize = 20f
            setTextColor(Color.parseColor("#1a1a1a"))
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams((44 * density).toInt(), LinearLayout.LayoutParams.MATCH_PARENT)
            setOnClickListener { close() }
        }

        titleView = TextView(this).apply {
            text = "登录" + providerLabel()
            textSize = 16f
            setTextColor(Color.parseColor("#1a1a1a"))
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
        }

        val spacer = TextView(this).apply {
            text = "幕海"
            textSize = 11f
            setTextColor(Color.parseColor("#55000000"))
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams((44 * density).toInt(), LinearLayout.LayoutParams.MATCH_PARENT)
        }

        bar.addView(back)
        bar.addView(titleView)
        bar.addView(spacer)

        // ── 登录 WebView（独立，不导航主 Tauri WebView）──
        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.userAgentString = DESKTOP_UA
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.cacheMode = WebSettings.LOAD_DEFAULT
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        webView.addJavascriptInterface(Bridge(), "NetdiskBridge")
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                injectScript()
            }
        }

        root.addView(bar)
        root.addView(webView)
        setContentView(root)

        handler = Handler(Looper.getMainLooper())
        startInjectLoop()

        // 系统返回键 / 手势返回：能在登录页内后退则后退一级，否则关闭并回传（返回网盘登录选择页）
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (::webView.isInitialized && webView.canGoBack()) {
                    webView.goBack()
                } else {
                    close()
                }
            }
        })

        if (url.isNotEmpty()) webView.loadUrl(url)
    }

    private fun providerLabel(): String {
        return when (provider) {
            "ali" -> "阿里云盘"
            "quark" -> "夸克网盘"
            "uc" -> "UC网盘"
            else -> ""
        }
    }

    /** 每 1s 重新注入抓取脚本（扛夸克整页跳转后脚本丢失），并在注入前声明原生顶栏/无陷阱标志。 */
    private fun injectScript() {
        if (done) return
        val pre = "window.__ND_NATIVE_BAR=true;window.__ND_NO_TRAP=true;"
        if (script.isNotEmpty()) webView.evaluateJavascript(pre + script, null)
    }

    private fun startInjectLoop() {
        handler.postDelayed(object : Runnable {
            override fun run() {
                if (!done) {
                    injectScript()
                    handler.postDelayed(this, 1000)
                }
            }
        }, 1000)
    }

    /** 关闭：把 token（或取消标记）写入结果文件并 finish，回到网盘登录选择页。 */
    private fun close() {
        if (done) return
        done = true
        val token = capturedToken
        val prov = provider
        val path = resultPath
        runOnUiThread {
            try {
                val obj = if (token != null) {
                    JSONObject().put("provider", prov).put("token", token)
                } else {
                    JSONObject().put("provider", prov).put("canceled", true)
                }
                val p = if (path.isNotEmpty()) path else File(filesDir, "netdisk_login_result.json").absolutePath
                File(p).writeText(obj.toString())
            } catch (e: Exception) {
                // 写入失败不影响关闭
            }
            finish()
        }
    }

    /** JS 桥：注入式脚本把抓取到的 token / 关闭请求交还原生层。 */
    inner class Bridge {
        @JavascriptInterface
        fun onTokenCaptured(token: String) {
            runOnUiThread {
                if (capturedToken == null) capturedToken = token
                titleView.text = "已登录 · 点击返回"
            }
        }

        @JavascriptInterface
        fun close() {
            runOnUiThread { this@NetdiskLoginActivity.close() }
        }
    }

    /** 系统状态栏高度（px），用于原生顶栏留出安全区，避免被通知栏压。 */
    private fun statusBarHeightPx(): Int {
        val res = resources
        val id = res.getIdentifier("status_bar_height", "dimen", "android")
        return if (id > 0) res.getDimensionPixelSize(id) else (24 * resources.displayMetrics.density).toInt()
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
