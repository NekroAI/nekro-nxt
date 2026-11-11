package ai.nekro.nxt

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.util.concurrent.Executors

/**
 * Pairs this phone with an instance (decisions A2, A3, A5). The main path is scanning the pairing code a signed-in
 * device shows: it carries the address, the instance's TLS key and a one-time code, so nothing is typed. Typing the
 * address is the fallback, followed by a pairing code or the management key in one field. A pairing link opened from
 * outside the app (the system camera, via [PairLinkActivity]) is shown with its address and connects only when the
 * user agrees.
 */
class ConnectActivity : ComponentActivity() {
    private enum class Step { START, ADDRESS, FOUND, LINK }

    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var profiles: InstanceProfiles
    private lateinit var intro: View
    private lateinit var addressSection: View
    private lateinit var address: EditText
    private lateinit var keySection: View
    private lateinit var found: TextView
    private lateinit var acceptInsecure: CheckBox
    private lateinit var secretSection: View
    private lateinit var secret: EditText
    private lateinit var error: TextView
    private lateinit var primary: Button
    private lateinit var secondary: Button
    private lateinit var progress: ProgressBar
    private var step = Step.START
    private var inspection: Inspection? = null
    private var link: PairingLink? = null
    private var busy = false

    private val scan = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        val parsed = PairingLink.parse(text)
        if (parsed == null) showError("这不是 NekroNXT 的配对二维码。请扫描「连接安卓应用」里显示的二维码。") else open(parsed)
    }

    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = goTo(Step.START)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_connect)
        profiles = InstanceProfiles(this)
        intro = findViewById(R.id.intro)
        addressSection = findViewById(R.id.addressSection)
        address = findViewById(R.id.address)
        keySection = findViewById(R.id.keySection)
        found = findViewById(R.id.found)
        acceptInsecure = findViewById(R.id.acceptInsecure)
        secretSection = findViewById(R.id.secretSection)
        secret = findViewById(R.id.secret)
        error = findViewById(R.id.error)
        primary = findViewById(R.id.primary)
        secondary = findViewById(R.id.secondary)
        progress = findViewById(R.id.progress)
        onBackPressedDispatcher.addCallback(this, back)

        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.updatePadding(top = bars.top, bottom = bars.bottom)
            insets
        }

        intent.getStringExtra(EXTRA_ADDRESS)?.let(address::setText)
        intent.getStringExtra(EXTRA_MESSAGE)?.let(::showError)
        address.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                if (step == Step.FOUND) goTo(Step.ADDRESS)
            }
        })
        address.setOnEditorActionListener { _, action, _ -> (action == EditorInfo.IME_ACTION_GO).also { if (it) onPrimary() } }
        secret.setOnEditorActionListener { _, action, _ -> (action == EditorInfo.IME_ACTION_DONE).also { if (it) onPrimary() } }
        acceptInsecure.setOnCheckedChangeListener { _, _ -> render() }
        primary.setOnClickListener { onPrimary() }
        secondary.setOnClickListener { goTo(Step.ADDRESS) }
        showSaved()
        render()
        openLinkFrom(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openLinkFrom(intent)
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun openLinkFrom(intent: Intent?) {
        val data = intent?.getStringExtra(EXTRA_LINK) ?: return
        val parsed = PairingLink.parse(data)
        if (parsed == null) showError("这个配对链接不完整，请重新扫描二维码。") else open(parsed)
    }

    private fun goTo(next: Step) {
        step = next
        if (next != Step.FOUND && next != Step.LINK) {
            inspection = null
            link = null
            secret.text.clear()
            acceptInsecure.isChecked = false
        }
        if (next == Step.ADDRESS) address.requestFocus()
        render()
    }

    private fun render() {
        val current = inspection
        intro.visibility = if (step == Step.START) View.VISIBLE else View.GONE
        addressSection.visibility = if (step == Step.ADDRESS || step == Step.FOUND) View.VISIBLE else View.GONE
        keySection.visibility = if (step == Step.FOUND || step == Step.LINK) View.VISIBLE else View.GONE
        secretSection.visibility = if (step == Step.FOUND) View.VISIBLE else View.GONE
        acceptInsecure.visibility = if (current?.transport == Transport.HTTP) View.VISIBLE else View.GONE
        secondary.visibility = if (step == Step.START) View.VISIBLE else View.GONE
        primary.text = when (step) {
            Step.START -> "扫码连接"
            Step.ADDRESS -> "下一步"
            Step.FOUND, Step.LINK -> "连接"
        }
        primary.isEnabled = !busy && (current?.transport != Transport.HTTP || acceptInsecure.isChecked)
        progress.visibility = if (busy) View.VISIBLE else View.GONE
        address.isEnabled = !busy
        secret.isEnabled = !busy
        back.isEnabled = step != Step.START
        if (current != null) found.text = describe(current, fromLink = step == Step.LINK)
    }

    private fun describe(found: Inspection, fromLink: Boolean): String {
        val version = if (found.productVersion.isEmpty()) "" else " ${found.productVersion}"
        val where = if (fromLink) "连接到 ${found.origin}\n" else ""
        return where + when (found.transport) {
            Transport.TRUSTED -> "已找到 NekroNXT$version，连接已加密。"
            Transport.PINNED ->
                if (fromLink) {
                    "已找到 NekroNXT$version。它使用自签名证书，和二维码里的一致，这台手机会记住它。"
                } else {
                    "已找到 NekroNXT$version。它使用自签名证书，这台手机会记住它的指纹，以后证书变化时会提醒你。\n" +
                        "指纹 ${Pins.display(found.spkiSha256.orEmpty()).take(39)}…"
                }
            Transport.HTTP ->
                "已找到 NekroNXT$version，但连接未加密：同一网络里的其他人可能看到你的对话和操作。" +
                    "只在可信的局域网或加密隧道里这样连接。"
        }
    }

    private fun onPrimary() {
        if (busy) return
        hideError()
        when (step) {
            Step.START -> scan.launch(
                ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt("扫描已登录设备上「连接安卓应用」的二维码")
                    .setBeepEnabled(false)
                    .setOrientationLocked(false),
            )
            Step.ADDRESS -> inspect(address.text.toString())
            Step.FOUND -> inspection?.let { enroll(it, secret.text.toString()) }
            Step.LINK -> {
                val found = inspection
                val pairing = link
                if (found != null && pairing != null) enroll(found, pairing.code)
            }
        }
    }

    private fun open(pairing: PairingLink) = inBackground {
        try {
            val inspected = InstanceClient.inspect(pairing.origin, pairing.spkiSha256)
            runOnUiThread {
                inspection = inspected
                link = pairing
                step = Step.LINK
            }
        } catch (failure: InstanceError) {
            runOnUiThread { showError(failure.message) }
        }
    }

    private fun inspect(text: String) = inBackground {
        try {
            val inspected = InstanceClient.inspect(text)
            runOnUiThread {
                inspection = inspected
                step = Step.FOUND
                secret.requestFocus()
            }
        } catch (failure: InstanceError) {
            runOnUiThread { showError(failure.message) }
        }
    }

    /** A pairing code when it looks like one, otherwise the management key. */
    private fun enroll(found: Inspection, credential: String) = inBackground {
        try {
            val label = "Android · ${Build.MANUFACTURER} ${Build.MODEL}".take(80)
            val release = "nxt-android/${BuildConfig.VERSION_NAME}"
            val code = InstanceClient.pairingCode(credential)
            val enrollment = if (code != null) {
                InstanceClient.enrollWithCode(found, code, label, release)
            } else {
                InstanceClient.enroll(found, credential.trim(), label, release)
            }
            val profile = InstanceProfile(
                instanceId = found.instanceId,
                origin = found.origin,
                transport = found.transport,
                spkiSha256 = found.spkiSha256,
                deviceId = enrollment.deviceId,
                name = found.origin.substringAfter("://"),
            )
            profiles.save(profile, enrollment.deviceSecret)
            runOnUiThread { openShell() }
        } catch (failure: InstanceError) {
            runOnUiThread { showError(failure.message) }
        }
    }

    /** Runs network work off the main thread with the form locked. */
    private fun inBackground(block: () -> Unit) {
        busy = true
        render()
        worker.execute {
            try {
                block()
            } finally {
                runOnUiThread {
                    busy = false
                    render()
                }
            }
        }
    }

    private fun showError(message: String?) {
        error.text = message ?: "连接失败。"
        error.visibility = View.VISIBLE
    }

    private fun hideError() {
        error.visibility = View.GONE
    }

    private fun showSaved() {
        val saved = profiles.all()
        val section = findViewById<View>(R.id.savedSection)
        val list = findViewById<LinearLayout>(R.id.savedList)
        section.visibility = if (saved.isEmpty()) View.GONE else View.VISIBLE
        list.removeAllViews()
        val current = profiles.current()?.instanceId
        val density = resources.displayMetrics.density
        for (profile in saved) {
            val row = TextView(this).apply {
                text = if (profile.instanceId == current) "${profile.name}（当前）" else profile.name
                textSize = 16f
                setTextColor(getColor(R.color.nxt_text))
                gravity = Gravity.CENTER_VERTICAL
                minHeight = (52 * density).toInt()
                setPadding((16 * density).toInt(), 0, (16 * density).toInt(), 0)
                setBackgroundResource(R.drawable.row)
                setOnClickListener {
                    profiles.select(profile.instanceId)
                    openShell()
                }
            }
            list.addView(
                row,
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                    .apply { bottomMargin = (8 * density).toInt() },
            )
        }
    }

    private fun openShell() {
        startActivity(Intent(this, WebShellActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }

    companion object {
        const val EXTRA_ADDRESS = "address"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_LINK = "link"
    }
}
