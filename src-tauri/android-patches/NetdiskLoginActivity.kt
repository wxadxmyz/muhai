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
import org.json.JSONArray
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
    // P4：登录前的 Cookie 键基线；登录后出现新键即视为登录态就绪
    private var baseKeys: Set<String>? = null
    private var done: Boolean = false

    private val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    /**
     * V4.2.0：按 provider 选 UA。
     *
     * 百度/迅雷的官方登录页是**移动版**（wappass.baidu.com 的「登录账号 体验完整功能」、
     * i.xunlei.com 的「手机验证登录」），用桌面 UA 打开会被重定向到 PC 版：
     *   - 百度 → passport.baidu.com/v2/ 「扫码登录 / 请使用百度App扫码登录」（与官方移动页完全不同）
     *   - 实测（Playwright + Chromium 412×915）：移动 UA 停在 wappass.baidu.com，
     *     桌面 UA 被 302 到 passport.baidu.com/v2/
     *
     * 但桌面 UA 不能全局改：夸克/阿里/UC 在移动 UA 下会被直接推到下载页，拿不到登录态
     * （V4.1.8 踩过这个坑）。所以这里按 provider 分别指定。
     */
    private val MOBILE_UA =
        "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

    private fun uaForProvider(): String =
        when (provider) {
            // 官方登录页只有移动版才正确渲染
            "baidu", "xunlei" -> MOBILE_UA
            else -> DESKTOP_UA
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        url = intent.getStringExtra("url") ?: ""
        provider = intent.getStringExtra("provider") ?: ""
        script = intent.getStringExtra("script") ?: ""
        resultPath = intent.getStringExtra("result_path") ?: ""

        val density = resources.displayMetrics.density
        // V4.1.7：本 Activity **未**开 edge-to-edge（与 MainActivity 的 enableEdgeToEdge() 不同），
        // 标准主题下内容区本就从状态栏下沿开始，顶栏无需再垫 statusBarHeight。
        // 此前 sbh 既算进了 barH 又算进了 padding，顶栏上方凭空多出整整一条状态栏高度的空白。

        // ── 根布局 ──
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.MATCH_PARENT
            )
        }

        // ── 原生顶部返回栏（替代注入式 DOM 顶栏）──
        val barH = (48 * density).toInt()
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, barH)
            // V4.1.7：不再垫 sbh（内容区已在状态栏下方），X / 标题直接落在顶栏垂直居中位置
            setPadding(0, 0, 0, 0)
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
            settings.userAgentString = uaForProvider()
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
            "baidu" -> "百度网盘"
            "xunlei" -> "迅雷云盘"
            else -> ""
        }
    }

    /**
     * 每 1s 重新注入抓取脚本（扛夸克整页跳转后脚本丢失），并在注入前声明原生顶栏/无陷阱标志。
     *
     * V4.1.8 ①：额外把 CookieManager 读到的完整 cookie 写进 window.__ND_COOKIES。
     * 夸克/UC 的登录态 cookie（__puus / __pus）是 HttpOnly，document.cookie 一律读不到，
     * 光靠页面脚本永远匹配不上登录态（表现为"已经登录进文件列表，顶栏却还显示登录xx网盘、
     * 已挂载列表里没有该盘"）。CookieManager 不受 HttpOnly 限制，这里作为兜底通道喂给注入脚本。
     */
    private fun cookieKeys(cookies: String): Set<String> =
        cookies.split(';').map { it.substringBefore('=').trim() }.filter { it.isNotEmpty() }.toSet()

    private fun injectScript() {
        if (done) return
        val cookies = readCookies()
        val keys = cookieKeys(cookies)
        // 首次注入时记录基线；之后每轮把「新出现的键名」喂给注入脚本。
        // 只传键名，绝不把 cookie 值带进诊断文案。
        if (baseKeys == null) baseKeys = keys
        val base = baseKeys ?: emptySet()
        val newKeys = keys - base
        val pre = "window.__ND_NATIVE_BAR=true;window.__ND_NO_TRAP=true;" +
            "window.__ND_COOKIES=" + JSONObject.quote(cookies) + ";" +
            "window.__ND_BASE_KEYS=" + JSONArray(base).toString() + ";" +
            "window.__ND_NEW_KEYS=" + JSONArray(newKeys).toString() + ";"
        if (script.isNotEmpty()) webView.evaluateJavascript(pre + script, null)
    }

    /** 当前页面（或起始登录页）可用 cookie 串；含 HttpOnly。 */
    private fun readCookies(): String {
        return try {
            val cm = CookieManager.getInstance()
            val u = if (::webView.isInitialized) (webView.url ?: url) else url
            if (u.isNotEmpty()) cm.getCookie(u) ?: "" else ""
        } catch (e: Exception) {
            ""
        }
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
                // 若 onLoginDetected 已写入带键名的诊断文案，不要用通用文案覆盖
                if (!titleView.text.toString().contains("新 Cookie 键")) titleView.text = "已登录 · 点击返回"
            }
        }

        /** P4：只展示新出现的 Cookie **键名**，绝不展示值。 */
        @JavascriptInterface
        fun onLoginDetected(keysJson: String) {
            runOnUiThread {
                val keys = try {
                    val a = JSONArray(keysJson)
                    (0 until a.length()).map { a.getString(it) }
                } catch (e: Exception) {
                    emptyList<String>()
                }
                titleView.text = if (keys.isNotEmpty())
                    "已登录 · 新 Cookie 键：" + keys.joinToString(", ") else "已登录 · 点击返回"
            }
        }

        @JavascriptInterface
        fun close() {
            runOnUiThread { this@NetdiskLoginActivity.close() }
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
