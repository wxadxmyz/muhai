#!/usr/bin/env bash
# V3.8.1 Phase 2：向 Tauri 生成的 Android 工程注入「原生 DEX 蜘蛛源」执行桥。
#
# 背景：catvod 系原生蜘蛛（肥猫.net 等）顶层 spider 是 APK/DEX，必须在 Android 端用
# DexClassLoader 加载，并实现 catvod 的 SpiderPool/Spider 接口 + `java` 宿主对象。
# Tauri 的 gen/android 被 gitignore，无法改仓库文件，故沿用「CI 构建期 patch」模式
# （与已有的 MainActivity back-button / MuHaiAndroid 桥一致）。
#
# 本脚本产出 3 个 Kotlin 文件 + 修改 MainActivity.kt：
#   1. com/github/catvod/csp/Java.kt      —— catvod `java` 宿主（同步 HTTP/md5/base64/stringToMap/getLocation）
#   2. com/github/catvod/spider/Init.kt   —— 静态 `java` 字段 + init(ctx)，DEX 通过它取宿主
#   3. com/muhai/app/CspNative.kt          —— MuHaiCsp @JavascriptInterface + DexClassLoader 逻辑 + MuHaiApp
#   4. MainActivity.kt                     —— onWebViewCreate 里注册 MuHaiCsp 桥 + 设置 context
#
# 设计要点（务必先看 V3.8.0 规划清单）：
#   - 不绕 Rust：前端检测原生 DEX 后直接 window.MuHaiCsp.require(json)，Kotlin 自包含执行。
#   - catvod 原生蜘蛛要求「同步」java.get/post，故 Java 宿主用 HttpURLConnection 同步实现，不异步回 Rust。
#   - DEX 的 parent classloader 指向 app classloader，使其能解析到我们注入的 com.github.catvod.* 宿主类。
#
# 部署前提：需真机验证。若 肥猫.net 的 DEX 入口类不是 com.github.catvod.spider.Manager，
# 或 java 宿主契约不符，运行期会报错——届时按真机日志微调本脚本即可。
set -e

echo "== CSP native DEX bridge patch =="

APP_SRC=$(find src-tauri/gen/android -type d -name java -path "*app/src/main*" 2>/dev/null | head -1)
if [ -z "$APP_SRC" ]; then
  echo "::error::Android java source dir not found (tauri android init 是否成功？)"
  exit 1
fi
echo "APP_SRC=$APP_SRC"

mkdir -p "$APP_SRC/com/github/catvod/csp" "$APP_SRC/com/github/catvod/spider" "$APP_SRC/com/muhai/app"

# ---------- 1) com.github.catvod.csp.Java：catvod java 宿主 ----------
cat > "$APP_SRC/com/github/catvod/csp/Java.kt" << 'KTEOF'
package com.github.catvod.csp

import android.util.Base64
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.LinkedHashMap

class Java(context: android.content.Context) {
    fun get(url: String): String = get(url, null)
    fun get(url: String, headers: Map<String, String>?): String = doHttp(url, "GET", null, headers)
    fun post(url: String, body: String): String = post(url, body, null)
    fun post(url: String, body: String, headers: Map<String, String>?): String = doHttp(url, "POST", body, headers)

    private fun doHttp(url: String, method: String, body: String?, headers: Map<String, String>?): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 20000
            conn.readTimeout = 20000
            conn.instanceFollowRedirects = false
            headers?.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.write(body.toByteArray(StandardCharsets.UTF_8))
            }
            val code = conn.responseCode
            if (code >= 300 && code < 400) {
                val loc = conn.getHeaderField("Location")
                if (loc != null && loc.isNotEmpty()) {
                    val next = if (loc.startsWith("http")) loc else (url.substringBeforeLast("/") + "/" + loc)
                    return get(next, headers)
                }
            }
            val stream = if (code < 400) conn.inputStream else conn.errorStream
            val rd = BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8))
            val sb = StringBuilder()
            var line: String? = rd.readLine()
            while (line != null) {
                sb.append(line)
                line = rd.readLine()
            }
            rd.close()
            return sb.toString()
        } finally {
            conn.disconnect()
        }
    }

    fun md5(s: String): String {
        val d = MessageDigest.getInstance("MD5").digest(s.toByteArray(StandardCharsets.UTF_8))
        val sb = StringBuilder()
        for (b in d) sb.append(String.format("%02x", b))
        return sb.toString()
    }

    fun base64Encode(s: String): String =
        Base64.encodeToString(s.toByteArray(StandardCharsets.UTF_8), Base64.NO_WRAP)

    fun base64Decode(s: String): String =
        String(Base64.decode(s, Base64.NO_WRAP), StandardCharsets.UTF_8)

    fun stringToMap(s: String): Map<String, String> {
        val m = LinkedHashMap<String, String>()
        for (kv in s.split("&")) {
            if (kv.isEmpty()) continue
            val idx = kv.indexOf("=")
            if (idx >= 0) m[kv.substring(0, idx)] = kv.substring(idx + 1) else m[kv] = ""
        }
        return m
    }

    fun getLocation(url: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "GET"
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 20000
            conn.readTimeout = 20000
            val loc = conn.getHeaderField("Location")
            return loc ?: url
        } finally {
            conn.disconnect()
        }
    }
}
KTEOF

# ---------- 2) com.github.catvod.spider.Init：静态 java 字段 + init(ctx) ----------
cat > "$APP_SRC/com/github/catvod/spider/Init.kt" << 'KTEOF'
package com.github.catvod.spider

import android.content.Context

class Init {
    companion object {
        @JvmField
        var java: Any? = null

        @JvmStatic
        fun init(context: Context) {
            if (java == null) java = com.github.catvod.csp.Java(context)
        }
    }
}
KTEOF

# ---------- 3) com.muhai.app.CspNative + MuHaiCsp + MuHaiApp ----------
cat > "$APP_SRC/com/muhai/app/CspNative.kt" << 'KTEOF'
package com.muhai.app

import android.content.Context
import android.webkit.JavascriptInterface
import com.github.catvod.spider.Init
import dalvik.system.DexClassLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.ArrayList
import java.util.HashMap

// 供 MuHaiCsp 取 Android Context（在 MainActivity.onWebViewCreate 里赋值）。
object MuHaiApp {
    var context: Context? = null
}

// 前端 window.MuHaiCsp.require(json) 入口：下载 DEX + md5 校验 + DexClassLoader 加载
// SpiderPool + getSpider(api, ext) + 反射注入 java 宿主 + 按 func 调 catvod 方法，返回 JSON 字符串。
object MuHaiCsp {
    private val pools = HashMap<String, Any>()
    private val spiders = HashMap<String, Any>()

    @JavascriptInterface
    fun require(argsJson: String): String {
        return try {
            val a = JSONObject(argsJson)
            val url = a.optString("spider_url")
            val md5 = a.optString("spider_md5")
            val api = a.optString("api")
            val ext = if (a.isNull("ext")) "" else a.get("ext").toString()
            val func = a.optString("func")
            val ctx = MuHaiApp.context
                ?: return "{\"__csp_error\":\"无法获取 Android Context（MuHaiApp.context 未设置）\"}"
            Init.init(ctx)
            val dexFile = fetchDex(ctx, url, md5)
                ?: return "{\"__csp_error\":\"原生蜘蛛下载或 md5 校验失败: $url\"}"
            // 用非空 val 承接（HashMap<String, Any> 取值返回 Any?，var 无法被智能推断为非空）
            val pool: Any = pools[url] ?: run {
                val optDir = File(ctx.cacheDir, "csp_opt").absolutePath
                val cl = DexClassLoader(dexFile.absolutePath, optDir, null, ctx.classLoader)
                val mgrClass = cl.loadClass("com.github.catvod.spider.Manager")
                val p: Any = mgrClass.getDeclaredConstructor().newInstance()
                mgrClass.getMethod("init", Context::class.java, String::class.java).invoke(p, ctx, "")
                pools[url] = p
                p
            }
            val getSpider = pool.javaClass.getMethod("getSpider", String::class.java, String::class.java)
            val key = url + "#" + api
            val spider: Any = spiders[key] ?: run {
                val s: Any = getSpider.invoke(pool, api, ext)
                    ?: throw RuntimeException("getSpider($api) 返回 null")
                injectJava(s)
                spiders[key] = s
                s
            }
            invokeFunc(spider, func, a)
        } catch (e: Throwable) {
            "{\"__csp_error\":\"MuHaiCsp 执行失败: ${e.message}\"}"
        }
    }

    // 把宿主 java 注入给 DEX 蜘蛛：兼容「DEX 读 Init.java 静态字段」与「DEX 自身持有 java 字段」两种写法。
    private fun injectJava(spider: Any) {
        try {
            val f = spider.javaClass.getField("java")
            if (f.get(spider) == null) f.set(spider, Init.java)
        } catch (ignored: Throwable) {
        }
        try {
            val initCls = spider.javaClass.classLoader.loadClass("com.github.catvod.spider.Init")
            val fj = initCls.getField("java")
            if (fj.get(null) == null) fj.set(null, Init.java)
        } catch (ignored: Throwable) {
        }
    }

    private fun invokeFunc(spider: Any, func: String, a: JSONObject): String {
        val c = spider.javaClass
        return when (func) {
            "homeContent" ->
                c.getMethod("homeContent").invoke(spider) as String
            "searchContent" -> {
                val arr = a.getJSONArray("args")
                val key = arr.getString(0)
                val quick = if (arr.length() > 1) arr.getBoolean(1) else false
                c.getMethod("searchContent", String::class.java, Boolean::class.javaPrimitiveType)
                    .invoke(spider, key, quick) as String
            }
            "detailContent" -> {
                val arr = a.getJSONArray("args")
                val list = ArrayList<String>()
                val first = arr.get(0)
                if (first is JSONArray) {
                    for (i in 0 until first.length()) list.add(first.getString(i))
                } else {
                    list.add(arr.getString(0))
                }
                c.getMethod("detailContent", List::class.java).invoke(spider, list) as String
            }
            "playerContent" -> {
                val arr = a.getJSONArray("args")
                val flag = arr.getString(0)
                val id = arr.getString(1)
                val vip = if (arr.length() > 2) arr.getJSONArray(2) else JSONArray()
                val vlist = ArrayList<String>()
                for (i in 0 until vip.length()) vlist.add(vip.getString(i))
                c.getMethod("playerContent", String::class.java, String::class.java, List::class.java)
                    .invoke(spider, flag, id, vlist) as String
            }
            else -> throw RuntimeException("不支持的 csp 方法: $func")
        }
    }

    private fun fetchDex(ctx: Context, url: String, md5: String): File? {
        val dir = File(ctx.cacheDir, "csp")
        dir.mkdirs()
        val name = if (md5.isEmpty()) ("spider_" + url.hashCode()) else md5
        val file = File(dir, "$name.dex")
        if (file.exists() && file.length() > 0 && (md5.isEmpty() || checkMd5(md5, file.readBytes()))) {
            return file
        }
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 30000
            conn.readTimeout = 30000
            val bytes = conn.inputStream.readBytes()
            if (md5.isNotEmpty() && !checkMd5(md5, bytes)) return null
            file.writeBytes(bytes)
            return file
        } finally {
            conn.disconnect()
        }
    }

    private fun checkMd5(expected: String, bytes: ByteArray): Boolean {
        val actual = StringBuilder()
        for (b in MessageDigest.getInstance("MD5").digest(bytes)) actual.append(String.format("%02x", b))
        return actual.toString().equals(expected, true)
    }
}
KTEOF

# ---------- 4) MainActivity.kt：注册 MuHaiCsp 桥 + 设置 context ----------
MAIN=$(find src-tauri/gen/android -name "MainActivity.kt" 2>/dev/null | head -1)
if [ -z "$MAIN" ]; then
  echo "::error::MainActivity.kt not found"
  exit 1
fi
python3 - "$MAIN" << 'PYEOF'
import sys, re
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
if "MuHaiCsp" in src:
    print("MuHaiCsp already registered, skip")
    sys.exit(0)
m = re.search(
    r'override fun onWebViewCreate\(webView: android\.webkit\.WebView\) \{\s*\n\s*super\.onWebViewCreate\(webView\)',
    src,
)
if not m:
    print("::warning::onWebViewCreate not found, skip MuHaiCsp registration")
    sys.exit(0)
inject = (
    '\n                    com.muhai.app.MuHaiApp.context = this\n'
    '                    webView.addJavascriptInterface(com.muhai.app.MuHaiCsp, "MuHaiCsp")\n'
)
idx = m.end()
src = src[:idx] + inject + src[idx:]
open(path, "w", encoding="utf-8").write(src)
print("Registered MuHaiCsp bridge in onWebViewCreate")
PYEOF

echo "== CSP native DEX bridge patch done =="
