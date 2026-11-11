package ai.nekro.nxt

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** How the shell reaches an instance; decides how TLS is checked for every request, native or WebView. */
enum class Transport {
    /** The instance's own self-signed certificate, pinned by its key fingerprint. */
    PINNED,

    /** A certificate the system trusts, usually a reverse proxy or tunnel in front of the instance. */
    TRUSTED,

    /** Plain HTTP, accepted only after the user confirmed the risk. */
    HTTP,
}

/**
 * One paired instance. The list is kept for several instances (decision A1, multi-instance data model); the first
 * version shows the current one and a simple switch.
 */
data class InstanceProfile(
    val instanceId: String,
    val origin: String,
    val transport: Transport,
    val spkiSha256: String?,
    val deviceId: String,
    val name: String,
) {
    fun toJson(): JSONObject =
        JSONObject()
            .put("instanceId", instanceId)
            .put("origin", origin)
            .put("transport", transport.name)
            .put("spkiSha256", spkiSha256 ?: JSONObject.NULL)
            .put("deviceId", deviceId)
            .put("name", name)

    companion object {
        fun fromJson(json: JSONObject) =
            InstanceProfile(
                instanceId = json.getString("instanceId"),
                origin = json.getString("origin"),
                transport = Transport.valueOf(json.getString("transport")),
                spkiSha256 = json.optString("spkiSha256").takeIf { !json.isNull("spkiSha256") && it.isNotEmpty() },
                deviceId = json.getString("deviceId"),
                name = json.getString("name"),
            )
    }
}

/**
 * Saved instances and their device secrets. The management key is never stored; the device secret is encrypted with
 * a Keystore key that cannot leave this phone (decision A3).
 */
class InstanceProfiles(context: Context) {
    private val prefs = context.getSharedPreferences("instances", Context.MODE_PRIVATE)

    fun all(): List<InstanceProfile> {
        val array = JSONArray(prefs.getString(KEY_PROFILES, "[]"))
        return (0 until array.length()).map { InstanceProfile.fromJson(array.getJSONObject(it)) }
    }

    fun current(): InstanceProfile? {
        val id = prefs.getString(KEY_CURRENT, null)
        return all().firstOrNull { it.instanceId == id } ?: all().firstOrNull()
    }

    fun select(instanceId: String) {
        prefs.edit().putString(KEY_CURRENT, instanceId).apply()
    }

    /** Adds or replaces the profile for this instance and makes it current. */
    fun save(profile: InstanceProfile, deviceSecret: String) {
        val others = all().filter { it.instanceId != profile.instanceId }
        val array = JSONArray()
        (others + profile).forEach { array.put(it.toJson()) }
        prefs.edit()
            .putString(KEY_PROFILES, array.toString())
            .putString(secretKey(profile.instanceId), SecretBox.seal(deviceSecret))
            .putString(KEY_CURRENT, profile.instanceId)
            .commit()
    }

    fun remove(instanceId: String) {
        val array = JSONArray()
        all().filter { it.instanceId != instanceId }.forEach { array.put(it.toJson()) }
        prefs.edit().putString(KEY_PROFILES, array.toString()).remove(secretKey(instanceId)).commit()
    }

    fun deviceSecret(profile: InstanceProfile): String? =
        prefs.getString(secretKey(profile.instanceId), null)?.let { runCatching { SecretBox.open(it) }.getOrNull() }

    private fun secretKey(instanceId: String) = "secret.$instanceId"

    private companion object {
        const val KEY_PROFILES = "profiles"
        const val KEY_CURRENT = "current"
    }
}

/** AES-GCM with a key held by Android Keystore. */
object SecretBox {
    private const val ALIAS = "nxt-device-secrets"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as SecretKey?)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun seal(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(sealed)
    }

    fun open(sealed: String): String {
        val bytes = Base64.getDecoder().decode(sealed)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
        return String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
    }
}
