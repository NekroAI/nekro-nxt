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
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import java.util.concurrent.Executors

/**
 * Pairs this phone with an instance (decision A2/A3). One path: address, then the management key; plain HTTP adds a
 * risk confirmation in between. A self-signed certificate is remembered on first use, as Desktop does; the pairing
 * proof is bound to that certificate, so a different server in between cannot reuse it.
 */
class ConnectActivity : ComponentActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var profiles: InstanceProfiles
    private lateinit var address: EditText
    private lateinit var keySection: View
    private lateinit var found: TextView
    private lateinit var acceptInsecure: CheckBox
    private lateinit var managementKey: EditText
    private lateinit var error: TextView
    private lateinit var primary: Button
    private lateinit var progress: ProgressBar
    private var inspection: Inspection? = null
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_connect)
        profiles = InstanceProfiles(this)
        address = findViewById(R.id.address)
        keySection = findViewById(R.id.keySection)
        found = findViewById(R.id.found)
        acceptInsecure = findViewById(R.id.acceptInsecure)
        managementKey = findViewById(R.id.managementKey)
        error = findViewById(R.id.error)
        primary = findViewById(R.id.primary)
        progress = findViewById(R.id.progress)

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
                if (inspection != null) reset()
            }
        })
        address.setOnEditorActionListener { _, action, _ -> (action == EditorInfo.IME_ACTION_GO).also { if (it) next() } }
        managementKey.setOnEditorActionListener { _, action, _ -> (action == EditorInfo.IME_ACTION_DONE).also { if (it) next() } }
        acceptInsecure.setOnCheckedChangeListener { _, _ -> render() }
        primary.setOnClickListener { next() }
        showSaved()
        render()
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun reset() {
        inspection = null
        managementKey.text.clear()
        acceptInsecure.isChecked = false
        render()
    }

    private fun render() {
        val current = inspection
        keySection.visibility = if (current == null) View.GONE else View.VISIBLE
        acceptInsecure.visibility = if (current?.transport == Transport.HTTP) View.VISIBLE else View.GONE
        primary.text = if (current == null) "下一步" else "连接"
        primary.isEnabled = !busy && (current?.transport != Transport.HTTP || acceptInsecure.isChecked)
        progress.visibility = if (busy) View.VISIBLE else View.GONE
        address.isEnabled = !busy
        managementKey.isEnabled = !busy
        if (current != null) found.text = describe(current)
    }

    private fun describe(found: Inspection): String {
        val version = if (found.productVersion.isEmpty()) "" else " ${found.productVersion}"
        return when (found.transport) {
            Transport.TRUSTED -> "已找到 NekroNXT$version，连接已加密。"
            Transport.PINNED ->
                "已找到 NekroNXT$version。它使用自签名证书，这台手机会记住它的指纹，以后证书变化时会提醒你。\n" +
                    "指纹 ${Pins.display(found.spkiSha256.orEmpty()).take(39)}…"
            Transport.HTTP ->
                "已找到 NekroNXT$version，但连接未加密：同一网络里的其他人可能看到你的对话和操作。" +
                    "只在可信的局域网或加密隧道里这样连接。"
        }
    }

    private fun next() {
        if (busy) return
        hideError()
        val current = inspection
        if (current == null) inspect(address.text.toString()) else enroll(current, managementKey.text.toString())
    }

    private fun inspect(text: String) = inBackground {
        try {
            val found = InstanceClient.inspect(text)
            runOnUiThread {
                inspection = found
                managementKey.requestFocus()
            }
        } catch (failure: InstanceError) {
            runOnUiThread { showError(failure.message) }
        }
    }

    private fun enroll(found: Inspection, key: String) = inBackground {
        try {
            val label = "Android · ${Build.MANUFACTURER} ${Build.MODEL}".take(80)
            val enrollment = InstanceClient.enroll(found, key, label, "nxt-android/${BuildConfig.VERSION_NAME}")
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
        for (profile in saved) {
            val row = TextView(this).apply {
                text = if (profile.instanceId == current) "${profile.name}（当前）" else profile.name
                textSize = 16f
                setTextColor(getColor(R.color.nxt_text))
                gravity = Gravity.CENTER_VERTICAL
                minHeight = (52 * resources.displayMetrics.density).toInt()
                setPadding((16 * resources.displayMetrics.density).toInt(), 0, (16 * resources.displayMetrics.density).toInt(), 0)
                setBackgroundResource(R.drawable.row)
                setOnClickListener {
                    profiles.select(profile.instanceId)
                    openShell()
                }
            }
            list.addView(
                row,
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                    .apply { bottomMargin = (8 * resources.displayMetrics.density).toInt() },
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
    }
}
