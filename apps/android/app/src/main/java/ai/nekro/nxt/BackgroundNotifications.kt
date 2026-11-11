package ai.nekro.nxt

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URLEncoder

/**
 * Notifications while the app is closed (decision A4): a foreground service keeps a long poll on the instance's
 * notification feed and posts each item as a system notification, filed in one channel per event so the system
 * settings can mute them separately. The foreground service needs a permanent notification in its own quiet channel;
 * the user turns the whole thing on after an explanation.
 */
object BackgroundNotifications {
    const val CHANNEL_CONNECTION = "connection"
    private const val CHANNEL_OTHER = "other"

    /** Settings events (apps/server notifications) and the names the web settings use for them. */
    private val EVENT_CHANNELS = linkedMapOf(
        "dynamic-client-approval-requested" to "创造任务等待确认运行",
        "credential-requested" to "凭据申请",
        "community-feedback-update" to "社区反馈更新",
        "extension-notification" to "扩展通知",
    )

    private fun prefs(context: Context) = context.getSharedPreferences("background", Context.MODE_PRIVATE)

    fun enabled(context: Context) = prefs(context).getBoolean("enabled", false)

    /** Whether the first-run explanation was shown (and answered either way). */
    fun introShown(context: Context) = prefs(context).getBoolean("introShown", false)

    fun markIntroShown(context: Context) = prefs(context).edit().putBoolean("introShown", true).apply()

    fun notificationsAllowed(context: Context): Boolean =
        context.getSystemService(NotificationManager::class.java).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 ||
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    fun batteryOptimized(context: Context): Boolean =
        !context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    /** What the web's settings page shows (`window.nekroAndroidState`). */
    fun state(context: Context): JSONObject =
        JSONObject()
            .put("backgroundNotifications", enabled(context))
            .put("batteryOptimized", batteryOptimized(context))
            .put("notificationsAllowed", notificationsAllowed(context))

    fun setEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean("enabled", enabled).apply()
        if (enabled) start(context) else context.stopService(Intent(context, BackgroundService::class.java))
    }

    /** Starts the service when it is turned on; called again after switching instances to follow the current one. */
    fun start(context: Context) {
        if (!enabled(context) || InstanceProfiles(context).current() == null) return
        context.startForegroundService(Intent(context, BackgroundService::class.java))
    }

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val channels = mutableListOf(
            NotificationChannel(CHANNEL_CONNECTION, "保持连接", NotificationManager.IMPORTANCE_MIN).apply {
                description = "后台通知开启时常驻，用来保持与实例的连接。可以在这里把它折叠起来，不影响其他提醒。"
                setShowBadge(false)
            },
        )
        EVENT_CHANNELS.forEach { (id, name) ->
            channels += NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH)
        }
        channels += NotificationChannel(CHANNEL_OTHER, "其他提醒", NotificationManager.IMPORTANCE_DEFAULT)
        manager.createNotificationChannels(channels)
    }

    fun channelFor(event: String?): String = if (event != null && event in EVENT_CHANNELS) event else CHANNEL_OTHER
}

class BackgroundService : Service() {
    @Volatile
    private var running = false
    private var thread: Thread? = null
    private var connectivityCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        BackgroundNotifications.ensureChannels(this)
        val profile = InstanceProfiles(this).current()
        if (profile == null || !BackgroundNotifications.enabled(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        val ongoing = Notification.Builder(this, BackgroundNotifications.CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("保持连接")
            .setContentText("与 ${profile.name} 保持连接，有需要处理的事时会提醒你。")
            .setContentIntent(openApp(null, profile.instanceId, 0))
            .setOngoing(true)
            .build()
        startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        // A new start (another instance chosen) replaces the loop.
        thread?.interrupt()
        running = true
        thread = Thread({ loop(profile) }, "nxt-notifications").apply { start() }
        watchNetwork()
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        thread?.interrupt()
        connectivityCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        super.onDestroy()
    }

    /** A network coming back ends the current wait, so the feed resumes at once instead of after the backoff. */
    private fun watchNetwork() {
        if (connectivityCallback != null) return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                thread?.interrupt()
            }
        }
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(callback)
        connectivityCallback = callback
    }

    /**
     * The same algorithm as Desktop (apps/desktop instance-manager): a baseline first so nothing old is shown, then
     * long polls; a new `bootId` or an unknown cursor brings a new baseline from the server.
     */
    private fun loop(profile: InstanceProfile) {
        val me = Thread.currentThread()
        var backoff = INITIAL_BACKOFF_MS
        var cookie: String? = null
        var cursor: Int? = null
        var boot = ""
        while (running && thread === me) {
            try {
                val secret = InstanceProfiles(this).deviceSecret(profile)
                    ?: throw InstanceError(InstanceError.Kind.DEVICE_REVOKED, "")
                val header = cookie ?: InstanceClient.openSession(profile, secret).cookies
                    .joinToString("; ") { it.substringBefore(';') }
                    .also { cookie = it }
                val query = buildString {
                    append("/api/client-notifications?events=1&boot=").append(URLEncoder.encode(boot, "UTF-8"))
                    cursor?.let { append("&cursor=").append(it).append("&wait=30") }
                }
                val connection = InstanceClient.connect(profile.origin + query, profile.transport, profile.spkiSha256)
                connection.readTimeout = 45_000
                connection.setRequestProperty("cookie", header)
                val feed = try {
                    when (connection.responseCode) {
                        HttpURLConnection.HTTP_OK -> JSONObject(connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) })
                        HttpURLConnection.HTTP_UNAUTHORIZED -> null
                        else -> throw IOException("HTTP ${connection.responseCode}")
                    }
                } finally {
                    connection.disconnect()
                }
                if (feed == null) {
                    // The session ended (instance restarted, or it expired): open a new one.
                    cookie = null
                    continue
                }
                val known = cursor != null
                cursor = feed.getInt("cursor")
                boot = feed.optString("bootId", boot)
                if (known) post(profile, feed.optJSONArray("notifications"))
                backoff = INITIAL_BACKOFF_MS
            } catch (_: InterruptedException) {
                backoff = INITIAL_BACKOFF_MS
            } catch (failure: InstanceError) {
                if (failure.kind == InstanceError.Kind.DEVICE_REVOKED) {
                    // This phone was signed out on the instance; the app will ask to connect again when opened.
                    BackgroundNotifications.setEnabled(this, false)
                    return
                }
                backoff = sleep(backoff)
            } catch (_: Exception) {
                cursor = null
                backoff = sleep(backoff)
            }
        }
    }

    /** Waits, unless interrupted by a returning network, and returns the next, longer wait. */
    private fun sleep(current: Long): Long {
        try {
            Thread.sleep(current)
        } catch (_: InterruptedException) {
            return INITIAL_BACKOFF_MS
        }
        return (current * 2).coerceAtMost(MAX_BACKOFF_MS)
    }

    private fun post(profile: InstanceProfile, items: org.json.JSONArray?) {
        if (items == null || items.length() == 0) return
        // The page shows its own state while it is in front; a system notification would only repeat it.
        if (WebShellActivity.visibleInstance == profile.instanceId) return
        if (!BackgroundNotifications.notificationsAllowed(this)) return
        // The feed may repeat an id; the newest one counts, as on Desktop.
        val latest = linkedMapOf<String, JSONObject>()
        for (index in 0 until items.length()) items.getJSONObject(index).let { latest[it.getString("id")] = it }
        val manager = getSystemService(NotificationManager::class.java)
        for (item in latest.values) {
            val id = item.getString("id")
            val route = item.optString("route").takeIf { it.startsWith("/") }
            val notification = Notification.Builder(this, BackgroundNotifications.channelFor(item.optString("event").ifEmpty { null }))
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(item.getString("title"))
                .setContentText(item.getString("body"))
                .setStyle(Notification.BigTextStyle().bigText(item.getString("body")))
                .setSubText(profile.name)
                .setWhen(item.optLong("occurredAt", System.currentTimeMillis()))
                .setShowWhen(true)
                .setAutoCancel(true)
                .setContentIntent(openApp(route, profile.instanceId, id.hashCode()))
                .build()
            manager.notify("${profile.instanceId}:$id", 1, notification)
        }
    }

    private fun openApp(route: String?, instanceId: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, WebShellActivity::class.java)
            .putExtra(WebShellActivity.EXTRA_INSTANCE, instanceId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        route?.let { intent.putExtra(WebShellActivity.EXTRA_ROUTE, it) }
        return PendingIntent.getActivity(
            this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private companion object {
        const val ONGOING_ID = 1
        const val INITIAL_BACKOFF_MS = 2_000L
        const val MAX_BACKOFF_MS = 60_000L
    }
}

/** Restarts the background connection after the phone starts or the app is updated, if it was on. */
class BackgroundStartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            BackgroundNotifications.start(context)
        }
    }
}
