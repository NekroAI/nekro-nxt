package ai.nekro.nxt

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/** One APK in a channel's manifest (scripts/mirror-android-release.mjs). */
data class AndroidRelease(
    val versionName: String,
    val versionCode: Int,
    val name: String,
    val size: Long,
    val sha256: String,
    val mirrorUrl: String,
    val githubUrl: String?,
    val releaseUrl: String?,
)

/**
 * In-app updates (decision A7): reads this build's channel manifest on the download mirror (dl.nekro.ai, reachable in
 * China), offers a newer version, downloads and checks it, then hands it to the system installer. The installer
 * itself refuses an APK signed with another key, so a tampered mirror cannot replace the app.
 */
object Updater {
    private const val MANIFEST = "https://dl.nekro.ai/nxt/android/%s/manifest.json"
    private const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L
    private val worker = Executors.newSingleThreadExecutor()

    private fun prefs(context: Context) = context.getSharedPreferences("updates", Context.MODE_PRIVATE)

    /** At most every six hours; a version the user put off is offered again only when an even newer one appears. */
    fun checkLater(activity: Activity) {
        val prefs = prefs(activity)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong("checkedAt", 0) < CHECK_INTERVAL_MS) return
        prefs.edit().putLong("checkedAt", now).apply()
        worker.execute {
            val release = try {
                latest(BuildConfig.UPDATE_CHANNEL)
            } catch (_: Exception) {
                return@execute
            }
            if (release.versionCode <= BuildConfig.VERSION_CODE) return@execute
            if (prefs.getInt("skipped", 0) >= release.versionCode) return@execute
            activity.runOnUiThread { if (!activity.isFinishing) offer(activity, release) }
        }
    }

    internal fun parse(manifest: JSONObject, manifestUrl: String): AndroidRelease {
        require(manifest.getString("format") == "nxt.android-mirror" && manifest.getInt("version") == 1)
        val file = manifest.getJSONObject("file")
        return AndroidRelease(
            versionName = manifest.getString("versionName"),
            versionCode = manifest.getInt("versionCode"),
            name = file.getString("name"),
            size = file.getLong("size"),
            sha256 = file.getString("sha256"),
            mirrorUrl = URI(manifestUrl).resolve(file.getString("path")).toString(),
            githubUrl = file.optString("githubUrl").ifEmpty { null },
            releaseUrl = manifest.optString("releaseUrl").ifEmpty { null },
        )
    }

    private fun latest(channel: String): AndroidRelease {
        val url = MANIFEST.format(channel)
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 10_000
            setRequestProperty("cache-control", "no-cache")
        }
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) throw IOException("HTTP ${connection.responseCode}")
            return parse(JSONObject(connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }), url)
        } finally {
            connection.disconnect()
        }
    }

    private fun offer(activity: Activity, release: AndroidRelease) {
        val size = "%.1f MB".format(release.size / 1024.0 / 1024.0)
        AlertDialog.Builder(activity)
            .setTitle("有新版本 ${release.versionName}")
            .setMessage("当前是 ${BuildConfig.VERSION_NAME}。更新包 $size，下载后由系统安装，应用里的登录不受影响。")
            .setPositiveButton("更新") { _, _ -> download(activity, release) }
            .setNegativeButton("以后再说") { _, _ -> prefs(activity).edit().putInt("skipped", release.versionCode).apply() }
            .apply {
                release.releaseUrl?.let { page ->
                    setNeutralButton("更新内容") { _, _ ->
                        try {
                            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(page)))
                        } catch (_: ActivityNotFoundException) {
                            // No browser: the dialog simply closes.
                        }
                    }
                }
            }
            .show()
    }

    private fun download(activity: Activity, release: AndroidRelease) {
        Toast.makeText(activity, "正在下载 ${release.versionName}…", Toast.LENGTH_SHORT).show()
        val target = File(File(activity.cacheDir, "updates").apply { mkdirs() }, release.name)
        worker.execute {
            val ok = listOfNotNull(release.mirrorUrl, release.githubUrl).any { url ->
                try {
                    fetch(url, target)
                    target.length() == release.size && sha256(target) == release.sha256
                } catch (_: IOException) {
                    false
                }
            }
            activity.runOnUiThread {
                if (!ok) {
                    target.delete()
                    Toast.makeText(activity, "更新下载失败，请稍后再试，或到下载页手动安装。", Toast.LENGTH_LONG).show()
                } else {
                    install(activity, target)
                }
            }
        }
    }

    /** The system asks once whether this app may install apps; afterwards it shows its own install screen. */
    fun install(activity: Activity, apk: File) {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            prefs(activity).edit().putString("pending", apk.path).apply()
            Toast.makeText(activity, "请允许 NekroNXT 安装应用，返回后会继续更新。", Toast.LENGTH_LONG).show()
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
            )
            return
        }
        prefs(activity).edit().remove("pending").apply()
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", apk)
        activity.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    /** Back from the "install apps" setting: continue with the download that waited for it. */
    fun resumePending(activity: Activity) {
        val path = prefs(activity).getString("pending", null) ?: return
        val apk = File(path)
        if (!apk.exists()) {
            prefs(activity).edit().remove("pending").apply()
            return
        }
        if (activity.packageManager.canRequestPackageInstalls()) install(activity, apk)
    }

    private fun fetch(url: String, target: File) {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 60_000
            instanceFollowRedirects = true
        }
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) throw IOException("HTTP ${connection.responseCode}")
            connection.inputStream.use { input -> target.outputStream().use { input.copyTo(it) } }
        } finally {
            connection.disconnect()
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
