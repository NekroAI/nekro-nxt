package ai.nekro.nxt

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.util.concurrent.Executors

/**
 * Shows the instance's own web in the system WebView (decision A1, A6). The page is the product; the shell only does
 * what a page cannot: sign in with the saved device credential, check the pinned certificate, hand the back gesture,
 * system insets, file picking and downloads to Android, and say plainly when the instance cannot be reached.
 */
class WebShellActivity : ComponentActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var profiles: InstanceProfiles
    private lateinit var profile: InstanceProfile
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private var notice: View? = null
    private var intro: View? = null
    private var overlayOpen = false
    private var renewing = false
    private var lastRenewal = 0L
    private var insetScript: ScriptHandler? = null
    private var insetsCss = ""
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var captureUri: Uri? = null

    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            if (overlayOpen) {
                webView.evaluateJavascript("window.nekroShellBack && window.nekroShellBack()", null)
            } else if (webView.canGoBack()) {
                webView.goBack()
            }
        }
    }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val picked = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            ?: result.data?.clipData?.let { clip -> Array(clip.itemCount) { clip.getItemAt(it).uri } }
        val photo = captureUri?.takeIf { result.resultCode == RESULT_OK && picked.isNullOrEmpty() && capturedPhoto() }
        captureUri = null
        callback.onReceiveValue(if (photo != null) arrayOf(photo) else picked)
    }

    private var pendingChooser: WebChromeClient.FileChooserParams? = null

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val params = pendingChooser ?: return@registerForActivityResult
        pendingChooser = null
        launchChooser(params, withCamera = granted)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        profiles = InstanceProfiles(this)
        if (intent?.action == ACTION_SWITCH) {
            openConnect(null)
            return
        }
        // A notification of another saved instance opens that one.
        intent?.getStringExtra(EXTRA_INSTANCE)?.let { id -> if (profiles.all().any { it.instanceId == id }) profiles.select(id) }
        profile = profiles.current() ?: run {
            openConnect(null)
            return
        }
        BackgroundNotifications.start(this)
        root = FrameLayout(this)
        setContentView(root)
        publishSwitchShortcut()
        onBackPressedDispatcher.addCallback(this, back)
        applyTheme(systemDark())

        val webViewMajor = WebViewCompat.getCurrentWebViewPackage(this)?.versionName
            ?.substringBefore('.')?.toIntOrNull()
        if (webViewMajor == null || webViewMajor < MIN_WEBVIEW_MAJOR ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        ) {
            showNotice(
                "系统 WebView 版本过旧",
                "当前版本 ${webViewMajor ?: "未知"}，至少需要 $MIN_WEBVIEW_MAJOR。请在应用商店更新「Android System WebView」或 Chrome 后重新打开。",
                retry = null,
            )
            return
        }
        setUpWebView()
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets -> applyInsets(insets) }
        start(savedInstanceState?.getString(STATE_URL) ?: intent?.getStringExtra(EXTRA_ROUTE)?.let { profile.origin + it })
        Updater.checkLater(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == ACTION_SWITCH) {
            openConnect(null)
            return
        }
        val instance = intent.getStringExtra(EXTRA_INSTANCE) ?: return
        if (::profile.isInitialized && instance != profile.instanceId) {
            // A notification of another instance: show that one from the start.
            setIntent(intent)
            recreate()
            return
        }
        val route = intent.getStringExtra(EXTRA_ROUTE) ?: return
        if (::webView.isInitialized) webView.loadUrl(profile.origin + route)
    }

    override fun onResume() {
        super.onResume()
        if (::profile.isInitialized) visibleInstance = profile.instanceId
        // Permissions and battery settings may have changed while the system settings were open.
        if (::webView.isInitialized) installPageScript()
        Updater.resumePending(this)
    }

    override fun onPause() {
        visibleInstance = null
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::webView.isInitialized) webView.url?.let { outState.putString(STATE_URL, it) }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // The page picks its theme itself and reports it; until then follow the system.
        if (!::webView.isInitialized) applyTheme(systemDark())
    }

    override fun onDestroy() {
        worker.shutdownNow()
        if (::webView.isInitialized) {
            root.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }

    /** Long-press the icon to switch instances; the page itself knows only the instance it belongs to. */
    private fun publishSwitchShortcut() {
        val shortcut = ShortcutInfoCompat.Builder(this, "switch_instance")
            .setShortLabel(getString(R.string.switch_instance))
            .setIcon(IconCompat.createWithResource(this, R.mipmap.ic_launcher))
            .setIntent(Intent(this, WebShellActivity::class.java).setAction(ACTION_SWITCH))
            .build()
        ShortcutManagerCompat.setDynamicShortcuts(this, listOf(shortcut))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        // Development builds can be inspected from chrome://inspect on a connected computer.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView.setBackgroundColor(getColor(R.color.nxt_canvas))
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            setSupportZoom(false)
            builtInZoomControls = false
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }
        WebViewCompat.addWebMessageListener(webView, "nekroAndroidShell", setOf(profile.origin)) { _, message, sourceOrigin, isMainFrame, _ ->
            if (isMainFrame && sourceOrigin.toString().trimEnd('/') == profile.origin) message.data?.let(::onPageMessage)
        }
        webView.webViewClient = ShellClient()
        webView.webChromeClient = ShellChrome()
        webView.setDownloadListener { url, _, contentDisposition, mimetype, _ ->
            download(url, URLUtil.guessFileName(url, contentDisposition, mimetype), mimetype)
        }
    }

    /** Opens a session from the saved device credential, then loads the page with it. */
    private fun start(path: String? = null) {
        hideNotice()
        val secret = profiles.deviceSecret(profile) ?: run {
            openConnect("这台手机保存的登录信息不可用，请重新连接。")
            return
        }
        worker.execute {
            try {
                val session = InstanceClient.openSession(profile, secret)
                runOnUiThread {
                    // Start from an empty jar: cookies of another instance, or a `Secure` one left by HTTPS on the
                    // same host, would otherwise block or shadow this session's cookies.
                    CookieManager.getInstance().removeAllCookies {
                        writeCookies(session)
                        val target = path?.takeIf { sameOrigin(it) } ?: "${profile.origin}/"
                        webView.loadUrl(target)
                    }
                }
            } catch (failure: InstanceError) {
                runOnUiThread { onConnectFailure(failure) }
            }
        }
    }

    /**
     * The session ended: the page reported it, or the instance sent a page load to its sign-in page. Open a new
     * session and show `target` (or reload). A second request within seconds means a new session does not help.
     */
    private fun renewSession(target: String? = null) {
        val now = System.currentTimeMillis()
        if (renewing) return
        if (now - lastRenewal < RENEW_INTERVAL_MS) {
            if (target != null) openConnect("无法恢复登录状态，请重新连接。")
            return
        }
        val secret = profiles.deviceSecret(profile) ?: return openConnect("这台手机保存的登录信息不可用，请重新连接。")
        renewing = true
        lastRenewal = now
        worker.execute {
            try {
                val session = InstanceClient.openSession(profile, secret)
                runOnUiThread {
                    writeCookies(session)
                    if (target == null) webView.reload() else webView.loadUrl(target)
                }
            } catch (failure: InstanceError) {
                runOnUiThread { onConnectFailure(failure) }
            } finally {
                runOnUiThread { renewing = false }
            }
        }
    }

    private fun onConnectFailure(failure: InstanceError) {
        when (failure.kind) {
            InstanceError.Kind.DEVICE_REVOKED -> openConnect("这台手机的登录已失效或被撤销，请重新连接。")
            InstanceError.Kind.IDENTITY_CHANGED -> showNotice(
                "实例的证书变了",
                "${profile.name} 出示的证书和第一次连接时不同。如果你刚重装过实例或换了证书，请重新连接；否则可能有人在冒充它。",
                retry = null,
            )
            InstanceError.Kind.UNREACHABLE -> showOffline()
            else -> showNotice("无法打开实例", failure.message ?: "实例返回了错误。", retry = { start() })
        }
    }

    private fun writeCookies(session: Session) {
        val cookies = CookieManager.getInstance()
        session.cookies.forEach { cookies.setCookie(profile.origin, it) }
        cookies.flush()
    }

    private fun onPageMessage(raw: String) {
        val message = try {
            JSONObject(raw)
        } catch (_: JSONException) {
            return
        }
        when (message.optString("type")) {
            "overlay" -> {
                overlayOpen = message.optBoolean("open")
                updateBack()
            }
            "session-expired" -> renewSession()
            "theme" -> applyTheme(message.optString("theme") == "dark")
            "save-file" -> saveFile(message.optString("name"), message.optString("mime"), message.optString("data"))
            "background-notifications" -> setBackground(message.optBoolean("enabled"))
            "battery-settings" -> openBatterySettings()
            "switch-instance" -> openConnect(null)
        }
    }

    private fun updateBack() {
        // Nothing left to close or go back to: the system takes the gesture and leaves the app, as on any
        // first-level page of a native app. The bottom bar's tabs deliberately add no history entries.
        back.isEnabled = notice == null && (overlayOpen || webView.canGoBack())
    }

    private fun systemDark() =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    private fun applyTheme(dark: Boolean) {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        val canvas = if (dark) DARK_CANVAS else LIGHT_CANVAS
        window.decorView.setBackgroundColor(canvas)
        if (::webView.isInitialized) webView.setBackgroundColor(canvas)
    }

    /**
     * Edge to edge: the page draws under the system bars and keeps clear of them through `--safe-*` (tokens.css).
     * The values come from here because older WebViews report zero for `env(safe-area-inset-*)`. The keyboard
     * shrinks the WebView instead, as Chrome does with `interactive-widget=resizes-content`, so the page's own
     * keyboard handling (keyboard-viewport.ts) sees the same thing as in the browser.
     */
    private fun applyInsets(insets: WindowInsetsCompat): WindowInsetsCompat {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val keyboard = insets.isVisible(WindowInsetsCompat.Type.ime())
        root.updatePadding(bottom = if (keyboard) ime.bottom else 0)
        notice?.updatePadding(top = bars.top, bottom = bars.bottom)
        intro?.updatePadding(top = bars.top, bottom = bars.bottom)
        val density = resources.displayMetrics.density
        fun css(px: Int) = "${(px / density).toInt()}px"
        val css = "--safe-top:${css(bars.top)};--safe-right:${css(bars.right)};" +
            "--safe-bottom:${css(if (keyboard) 0 else bars.bottom)};--safe-left:${css(bars.left)}"
        if (css != insetsCss) {
            insetsCss = css
            installPageScript()
        }
        return WindowInsetsCompat.CONSUMED
    }

    /**
     * The insets and the phone's state (`window.nekroAndroidState`, android-shell.ts), for pages loaded from now on
     * (before their own scripts run) and for the page already showing.
     */
    private fun installPageScript() {
        val state = BackgroundNotifications.state(this).toString()
        val apply = "(()=>{window.nekroAndroidState=$state;dispatchEvent(new Event('nekro-android-state'));" +
            "const v=${JSONObject.quote(insetsCss)}.split(';').filter(Boolean);" +
            "const a=()=>{const r=document.documentElement;if(!r)return false;" +
            "for(const p of v){const i=p.indexOf(':');r.style.setProperty(p.slice(0,i),p.slice(i+1))}return true};" +
            "if(!a())new MutationObserver((_,o)=>{if(a())o.disconnect()}).observe(document,{childList:true})})()"
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            insetScript?.remove()
            insetScript = WebViewCompat.addDocumentStartJavaScript(webView, apply, setOf(profile.origin))
        }
        webView.evaluateJavascript(apply, null)
    }

    private fun sameOrigin(url: String?): Boolean {
        val uri = url?.let(Uri::parse) ?: return false
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "${uri.scheme}://${uri.host}$port".lowercase() == profile.origin
    }

    private inner class ShellClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (sameOrigin(url.toString())) {
                // The edge's sign-in page is for browsers; the shell signs in with its device credential instead.
                if (url.path != "/login") return false
                val next = url.getQueryParameter("next")?.takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/"
                renewSession(profile.origin + next)
                return true
            }
            // Everything else leaves the app: community pages, docs, mail and phone links.
            try {
                startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(this@WebShellActivity, "没有可以打开这个链接的应用。", Toast.LENGTH_SHORT).show()
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            overlayOpen = false
            updateBack()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) = updateBack()

        override fun onPageFinished(view: WebView, url: String?) {
            updateBack()
            if (sameOrigin(url) && notice == null && !BackgroundNotifications.introShown(this@WebShellActivity)) showIntro()
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val certificate = error.certificate.x509Certificate
            if (profile.transport == Transport.PINNED && sameOrigin(error.url) && certificate != null &&
                Pins.spkiSha256(certificate) == profile.spkiSha256
            ) {
                handler.proceed()
                return
            }
            handler.cancel()
            if (sameOrigin(error.url)) {
                onConnectFailure(InstanceError(InstanceError.Kind.IDENTITY_CHANGED, "服务器 TLS 身份已经变化。"))
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showOffline()
        }
    }

    private inner class ShellChrome : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            val acceptsImages = params.acceptTypes.all { it.isBlank() } ||
                params.acceptTypes.any { it.startsWith("image/") || it == "*/*" }
            // The scanner declares the camera permission, and then the camera app may only be started once it is
            // granted; ask first, and offer files alone if it is refused.
            if (acceptsImages && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                pendingChooser = params
                askCamera.launch(Manifest.permission.CAMERA)
                return true
            }
            return launchChooser(params, withCamera = acceptsImages)
        }
    }

    private fun launchChooser(params: WebChromeClient.FileChooserParams, withCamera: Boolean): Boolean {
        val content = params.createIntent().apply {
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }
        val chooser = Intent.createChooser(content, null)
        if (withCamera) cameraIntent()?.let { chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(it)) }
        return try {
            pickFiles.launch(chooser)
            true
        } catch (_: ActivityNotFoundException) {
            fileCallback?.onReceiveValue(null)
            fileCallback = null
            captureUri = null
            false
        }
    }

    /** "Take a photo" next to the file pickers, through the camera app. */
    private fun cameraIntent(): Intent? {
        val directory = File(cacheDir, "captures").apply { mkdirs() }
        directory.listFiles()?.forEach { it.delete() }
        val file = File(directory, "photo-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (intent.resolveActivity(packageManager) == null) return null
        captureUri = uri
        return intent
    }

    private fun capturedPhoto(): Boolean =
        File(cacheDir, "captures").listFiles()?.any { it.length() > 0 } == true

    /** Same-origin links with `download`; fetched natively so the pinned certificate is checked here too. */
    private fun download(url: String, name: String, mime: String?) {
        if (!sameOrigin(url)) return
        val cookie = CookieManager.getInstance().getCookie(url)
        Toast.makeText(this, "正在下载 $name", Toast.LENGTH_SHORT).show()
        worker.execute {
            val saved = try {
                val connection = InstanceClient.connect(url, profile.transport, profile.spkiSha256)
                connection.readTimeout = 60_000
                cookie?.let { connection.setRequestProperty("cookie", it) }
                try {
                    if (connection.responseCode != HttpURLConnection.HTTP_OK) throw IOException("HTTP ${connection.responseCode}")
                    connection.inputStream.use { input -> writeDownload(name, mime ?: connection.contentType) { input.copyTo(it) } }
                } finally {
                    connection.disconnect()
                }
            } catch (_: Exception) {
                false
            }
            runOnUiThread { reportDownload(name, saved) }
        }
    }

    private fun saveFile(name: String, mime: String, base64: String) {
        val filename = name.ifBlank { "download" }
        worker.execute {
            val saved = try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                writeDownload(filename, mime.ifBlank { null }) { it.write(bytes) }
            } catch (_: Exception) {
                false
            }
            runOnUiThread { reportDownload(filename, saved) }
        }
    }

    private fun writeDownload(name: String, mime: String?, write: (java.io.OutputStream) -> Unit): Boolean {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime?.substringBefore(';') ?: "application/octet-stream")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = contentResolver
        val item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
        return try {
            resolver.openOutputStream(item)?.use(write) ?: throw IOException("No output stream.")
            resolver.update(item, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            true
        } catch (error: Exception) {
            resolver.delete(item, null, null)
            false
        }
    }

    private fun reportDownload(name: String, saved: Boolean) {
        Toast.makeText(this, if (saved) "已保存到「下载」：$name" else "下载失败：$name", Toast.LENGTH_LONG).show()
    }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        enableBackground()
    }

    /** Turned on from the first-run explanation or the web's settings; asks for the notification permission first. */
    private fun setBackground(enabled: Boolean) {
        if (!enabled) {
            BackgroundNotifications.setEnabled(this, false)
            installPageScript()
            return
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            enableBackground()
        }
    }

    private fun enableBackground() {
        BackgroundNotifications.setEnabled(this, true)
        installPageScript()
        // The system stops apps under battery optimization; ask right away while the reason is fresh.
        if (BackgroundNotifications.batteryOptimized(this)) openBatterySettings()
    }

    @SuppressLint("BatteryLife")
    private fun openBatterySettings() {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        try {
            startActivity(direct)
        } catch (_: ActivityNotFoundException) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(this, "请在系统设置里允许 NekroNXT 在后台运行。", Toast.LENGTH_LONG).show()
            }
        }
    }

    /** Shown once after the first page load: what background notifications cost and do, then the user decides. */
    private fun showIntro() {
        BackgroundNotifications.markIntroShown(this)
        val view = layoutInflater.inflate(R.layout.background_intro, root, false)
        val close = {
            root.removeView(view)
            intro = null
        }
        view.findViewById<Button>(R.id.introEnable).setOnClickListener {
            close()
            setBackground(true)
        }
        view.findViewById<Button>(R.id.introLater).setOnClickListener { close() }
        root.addView(view)
        intro = view
        ViewCompat.requestApplyInsets(root)
    }

    private fun showOffline() {
        showNotice(
            "连不上实例",
            "${profile.name} 现在无法访问。请确认实例在运行，并且这台手机能访问这个地址。",
            retry = { start(webView.url?.takeIf { sameOrigin(it) }) },
        )
    }

    /**
     * The shell's own page for when the instance cannot be shown. The web's offline page needs a service worker,
     * which Chromium does not register for a self-signed certificate, so the shell covers every case itself.
     */
    private fun showNotice(title: String, message: String, retry: (() -> Unit)?) {
        hideNotice()
        val view = layoutInflater.inflate(R.layout.notice, root, false)
        view.findViewById<TextView>(R.id.noticeTitle).text = title
        view.findViewById<TextView>(R.id.noticeMessage).text = message
        view.findViewById<Button>(R.id.noticeRetry).apply {
            visibility = if (retry == null) View.GONE else View.VISIBLE
            setOnClickListener { retry?.invoke() }
        }
        view.findViewById<Button>(R.id.noticeConnect).setOnClickListener { openConnect(null) }
        root.addView(view)
        notice = view
        ViewCompat.requestApplyInsets(root)
        updateBackIfReady()
    }

    private fun hideNotice() {
        notice?.let(root::removeView)
        notice = null
        updateBackIfReady()
    }

    private fun updateBackIfReady() {
        if (::webView.isInitialized) updateBack()
    }

    private fun openConnect(message: String?) {
        val intent = Intent(this, ConnectActivity::class.java)
        message?.let { intent.putExtra(ConnectActivity.EXTRA_MESSAGE, it) }
        if (::profile.isInitialized) intent.putExtra(ConnectActivity.EXTRA_ADDRESS, profile.origin)
        startActivity(intent)
        finish()
    }

    companion object {
        const val ACTION_SWITCH = "ai.nekro.nxt.SWITCH_INSTANCE"
        const val EXTRA_INSTANCE = "instance"
        const val EXTRA_ROUTE = "route"

        /** The instance whose page is in front, so its notifications are not repeated by the system. */
        @Volatile
        var visibleInstance: String? = null
        private const val STATE_URL = "url"
        private const val RENEW_INTERVAL_MS = 5_000L

        /** `color-mix()` in the web's styles needs Chromium 111. */
        private const val MIN_WEBVIEW_MAJOR = 111
        private const val LIGHT_CANVAS = 0xFFF3F1EC.toInt()
        private const val DARK_CANVAS = 0xFF0B1524.toInt()
    }
}
