package ai.nekro.nxt

import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLException

class InstanceError(val kind: Kind, message: String) : Exception(message) {
    enum class Kind { UNREACHABLE, NOT_NXT, INCOMPATIBLE, IDENTITY_CHANGED, KEY_REJECTED, RATE_LIMITED, DEVICE_REVOKED, FAILED }
}

/** What an address turned out to be, before any credential is sent to it. */
data class Inspection(
    val origin: String,
    val transport: Transport,
    val spkiSha256: String?,
    val instanceId: String,
    val productVersion: String,
)

data class Enrollment(val deviceId: String, val deviceSecret: String)

/**
 * What a pairing QR code holds (decision A5): `nekronxt://pair?origin=…&code=…&spki=…`. The key is the instance's own
 * TLS key, so a self-signed instance is checked against it instead of trusted on first use.
 */
data class PairingLink(val origin: String, val code: String, val spkiSha256: String?) {
    companion object {
        fun parse(text: String): PairingLink? {
            val uri = try {
                URI(text.trim())
            } catch (_: Exception) {
                return null
            }
            if (uri.scheme != "nekronxt" || uri.host != "pair") return null
            val query = (uri.rawQuery ?: return null).split('&').mapNotNull {
                val parts = it.split('=', limit = 2)
                if (parts.size == 2) parts[0] to java.net.URLDecoder.decode(parts[1], "UTF-8") else null
            }.toMap()
            val origin = try {
                InstanceClient.normalizeOrigin(query["origin"] ?: return null)
            } catch (_: InstanceError) {
                return null
            }
            val code = InstanceClient.pairingCode(query["code"] ?: return null) ?: return null
            return PairingLink(origin, code, query["spki"]?.takeIf { it.matches(Regex("^[A-Za-z0-9_-]{43}$")) })
        }
    }
}

data class Session(val cookies: List<String>, val csrfToken: String)

/**
 * The pairing protocol Desktop speaks (apps/desktop/src/remote-pairing.ts, decision A2/A3): read the descriptor,
 * prove the management key against a fresh challenge, get a device credential, open sessions with it.
 */
object InstanceClient {
    /** Management protocols this shell speaks; the shell is versioned apart from NXT and checks this instead. */
    private val SUPPORTED_MANAGEMENT_PROTOCOLS = setOf(1)
    private const val PAIR_PROOF_PREFIX = "nxt-management-pair-v1"
    private const val INSECURE_HTTP_PAIR_PROOF_PREFIX = "nxt-management-pair-insecure-http-v1"
    private const val MAX_RESPONSE_BYTES = 256 * 1024
    private const val TIMEOUT_MS = 10_000

    /** `nxt.example.com`, `192.168.1.5:4960` or a full URL; HTTPS unless the user wrote `http://`. */
    fun normalizeOrigin(address: String): String {
        val trimmed = address.trim().trimEnd('/')
        if (trimmed.isEmpty()) throw InstanceError(InstanceError.Kind.FAILED, "请输入实例地址。")
        val withScheme = if (trimmed.contains("://")) trimmed else "https://$trimmed"
        val uri = try {
            URI(withScheme)
        } catch (_: Exception) {
            throw InstanceError(InstanceError.Kind.FAILED, "地址格式不正确。")
        }
        val scheme = uri.scheme?.lowercase()
        if ((scheme != "https" && scheme != "http") || uri.host.isNullOrEmpty() || uri.userInfo != null) {
            throw InstanceError(InstanceError.Kind.FAILED, "地址格式不正确。")
        }
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "$scheme://${uri.host.lowercase()}$port"
    }

    /** `ABCD-EFGH` from what a person typed; null when it is not a pairing code (then it is a management key). */
    fun pairingCode(input: String): String? {
        val compact = input.uppercase().filter { it.isLetterOrDigit() }
        if (compact.length != 8 || compact.any { it !in PAIRING_ALPHABET }) return null
        return "${compact.take(4)}-${compact.drop(4)}"
    }

    private const val PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

    /**
     * `expectedSpki` comes from a pairing QR code: a self-signed instance must present exactly that key. Without it the
     * key the instance presents now is remembered (trust on first use, as Desktop does).
     */
    fun inspect(address: String, expectedSpki: String? = null): Inspection {
        val origin = normalizeOrigin(address)
        if (origin.startsWith("http://")) return describe(origin, Transport.HTTP, null)
        return try {
            describe(origin, Transport.TRUSTED, null)
        } catch (error: InstanceError) {
            if (error.cause !is SSLException) throw error
            // Not trusted by the system: read the certificate it presents, so the user can confirm its fingerprint.
            val trust = Pins.PinningTrustManager(null)
            val descriptor = fetchDescriptor(origin, Transport.PINNED, null, trust)
            val leaf = trust.observed?.firstOrNull()
                ?: throw InstanceError(InstanceError.Kind.IDENTITY_CHANGED, "服务器没有提供可验证的 TLS 证书。")
            val spki = Pins.spkiSha256(leaf)
            if (expectedSpki != null && spki != expectedSpki) {
                throw InstanceError(
                    InstanceError.Kind.IDENTITY_CHANGED,
                    "这个地址出示的证书和二维码里的不一致。请确认手机连的是同一个实例，不要在不信任的网络里配对。",
                )
            }
            inspection(origin, Transport.PINNED, spki, descriptor)
        }
    }

    private fun describe(origin: String, transport: Transport, spki: String?): Inspection =
        inspection(origin, transport, spki, fetchDescriptor(origin, transport, spki, null))

    private fun fetchDescriptor(
        origin: String,
        transport: Transport,
        spki: String?,
        trust: Pins.PinningTrustManager?,
    ): JSONObject = request(origin, "/.well-known/nekro-nxt", "GET", null, transport, spki, trust).let {
        if (it.status != 200 || it.json == null) {
            throw InstanceError(InstanceError.Kind.NOT_NXT, "该地址没有返回可识别的 NekroNXT 实例描述。")
        }
        it.json
    }

    private fun inspection(origin: String, transport: Transport, spki: String?, descriptor: JSONObject): Inspection {
        if (descriptor.optString("format") != "nxt.instance-descriptor" || !descriptor.has("instanceId")) {
            throw InstanceError(InstanceError.Kind.NOT_NXT, "该地址没有返回可识别的 NekroNXT 实例描述。")
        }
        if (descriptor.optInt("descriptorVersion") != 1 ||
            descriptor.optInt("managementProtocol") !in SUPPORTED_MANAGEMENT_PROTOCOLS
        ) {
            throw InstanceError(InstanceError.Kind.INCOMPATIBLE, "这个实例的版本与当前应用不兼容，请更新应用或实例。")
        }
        return Inspection(
            origin = origin,
            transport = transport,
            spkiSha256 = spki,
            instanceId = descriptor.getString("instanceId"),
            productVersion = descriptor.optString("productVersion"),
        )
    }

    fun enroll(inspection: Inspection, managementKey: String, label: String, clientReleaseId: String): Enrollment {
        if (managementKey.length < 32) {
            throw InstanceError(InstanceError.Kind.KEY_REJECTED, "管理密钥至少需要 32 个字符。")
        }
        val (origin, transport, spki) = Triple(inspection.origin, inspection.transport, inspection.spkiSha256)
        val challenge = request(origin, "/api/management/pairing/challenge", "POST", JSONObject(), transport, spki)
            .expectOk()
        if (challenge.optString("instanceId") != inspection.instanceId) {
            throw InstanceError(InstanceError.Kind.IDENTITY_CHANGED, "服务器身份验证失败，请重新添加该实例。")
        }
        val clientNonce = randomToken()
        val proofLines = if (challenge.has("transportBinding")) {
            listOf(
                INSECURE_HTTP_PAIR_PROOF_PREFIX, challenge.getString("challengeId"), challenge.getString("serverNonce"),
                clientNonce, inspection.instanceId, challenge.getString("transportBinding"),
            )
        } else {
            val challengeSpki = challenge.getString("spkiSha256")
            // Pinned: the key in the challenge must be the one we pinned. Behind a trusted proxy the instance reports
            // its own certificate, which the phone never sees; the system's certificate check stands in for the pin.
            if (transport == Transport.PINNED && challengeSpki != spki) {
                throw InstanceError(InstanceError.Kind.IDENTITY_CHANGED, "服务器身份验证失败，请重新添加该实例。")
            }
            listOf(
                PAIR_PROOF_PREFIX, challenge.getString("challengeId"), challenge.getString("serverNonce"),
                clientNonce, inspection.instanceId, challengeSpki,
            )
        }
        val proof = pairProof(managementKey, proofLines)
        val body = JSONObject()
            .put("challengeId", challenge.getString("challengeId"))
            .put("clientNonce", clientNonce)
            .put("proof", proof)
            .put("label", label.take(80))
            .put("clientReleaseId", clientReleaseId)
        val enrolled = request(origin, "/api/management/devices/enroll", "POST", body, transport, spki).let {
            if (it.status == 401 || it.status == 403) {
                throw InstanceError(InstanceError.Kind.KEY_REJECTED, it.problemMessage ?: "管理密钥不正确。")
            }
            it.expectOk()
        }
        return Enrollment(enrolled.getString("deviceId"), enrolled.getString("deviceSecret"))
    }

    /** Pairs with a code a signed-in device showed; no management key involved. */
    fun enrollWithCode(inspection: Inspection, code: String, label: String, clientReleaseId: String): Enrollment {
        val body = JSONObject()
            .put("pairingCode", code)
            .put("label", label.take(80))
            .put("clientReleaseId", clientReleaseId)
        val enrolled = request(
            inspection.origin, "/api/management/devices/enroll", "POST", body, inspection.transport, inspection.spkiSha256,
        ).let {
            if (it.status == 401) {
                throw InstanceError(InstanceError.Kind.KEY_REJECTED, it.problemMessage ?: "配对码无效或已过期。")
            }
            it.expectOk()
        }
        return Enrollment(enrolled.getString("deviceId"), enrolled.getString("deviceSecret"))
    }

    /** HMAC-SHA256 over the challenge lines, as Desktop's `createHmac('sha256', key)` computes it. */
    internal fun pairProof(managementKey: String, lines: List<String>): String {
        val mac = Mac.getInstance("HmacSHA256").apply {
            init(SecretKeySpec(managementKey.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        }
        return base64Url(mac.doFinal(lines.joinToString("\n").toByteArray(Charsets.UTF_8)))
    }

    fun openSession(profile: InstanceProfile, deviceSecret: String): Session {
        val body = JSONObject().put("deviceId", profile.deviceId).put("deviceSecret", deviceSecret)
        val response = request(
            profile.origin, "/api/management/session", "POST", body, profile.transport, profile.spkiSha256,
        )
        if (response.status == 401) {
            throw InstanceError(InstanceError.Kind.DEVICE_REVOKED, response.problemMessage ?: "设备会话已经失效，请重新认证。")
        }
        val json = response.expectOk()
        val cookies = response.setCookies
        if (cookies.isEmpty()) throw InstanceError(InstanceError.Kind.FAILED, "服务器没有建立会话。")
        return Session(cookies, json.optString("csrfToken"))
    }

    /** A connection that checks TLS the way this profile requires; also used for downloads. */
    fun connect(url: String, transport: Transport, spki: String?, trust: Pins.PinningTrustManager? = null): HttpURLConnection {
        val connection = URL(url).openConnection() as HttpURLConnection
        if (connection is HttpsURLConnection && transport == Transport.PINNED) {
            connection.sslSocketFactory = Pins.socketFactory(trust ?: Pins.PinningTrustManager(spki))
            connection.hostnameVerifier = Pins.pinnedHostnames
        }
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        connection.instanceFollowRedirects = false
        return connection
    }

    private class Response(val status: Int, val json: JSONObject?, val setCookies: List<String>) {
        val problemMessage: String? get() = json?.optJSONObject("error")?.optString("message")?.takeIf { it.isNotEmpty() }

        fun expectOk(): JSONObject {
            if (status == 429) throw InstanceError(InstanceError.Kind.RATE_LIMITED, problemMessage ?: "请求过于频繁，请稍后重试。")
            if (status !in 200..299 || json == null) {
                throw InstanceError(InstanceError.Kind.FAILED, problemMessage ?: "实例返回了错误（$status）。")
            }
            return json
        }
    }

    private fun request(
        origin: String,
        path: String,
        method: String,
        body: JSONObject?,
        transport: Transport,
        spki: String?,
        trust: Pins.PinningTrustManager? = null,
    ): Response {
        val connection = connect(origin + path, transport, spki, trust)
        try {
            connection.requestMethod = method
            connection.setRequestProperty("accept", "application/json")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("content-type", "application/json")
                connection.setRequestProperty("origin", origin)
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val bytes = stream?.use { input ->
                val buffer = input.readNBytesCompat(MAX_RESPONSE_BYTES + 1)
                if (buffer.size > MAX_RESPONSE_BYTES) throw InstanceError(InstanceError.Kind.FAILED, "实例的响应过大。")
                buffer
            }
            val json = bytes?.let {
                try {
                    JSONObject(String(it, Charsets.UTF_8))
                } catch (_: JSONException) {
                    null
                }
            }
            val cookies = connection.headerFields.entries
                .filter { it.key.equals("set-cookie", ignoreCase = true) }
                .flatMap { it.value }
            return Response(status, json, cookies)
        } catch (error: SSLException) {
            val kind = if (transport == Transport.PINNED && spki != null) InstanceError.Kind.IDENTITY_CHANGED else InstanceError.Kind.UNREACHABLE
            val message = if (kind == InstanceError.Kind.IDENTITY_CHANGED) "服务器 TLS 身份已经变化，请重新认证。" else "无法建立安全连接。"
            throw InstanceError(kind, message).apply { initCause(error) }
        } catch (error: IOException) {
            throw InstanceError(InstanceError.Kind.UNREACHABLE, "连不上这个地址，请检查地址和网络。").apply { initCause(error) }
        } finally {
            connection.disconnect()
        }
    }

    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(8 * 1024)
        while (out.size() < limit) {
            val read = read(chunk, 0, minOf(chunk.size, limit - out.size()))
            if (read < 0) break
            out.write(chunk, 0, read)
        }
        return out.toByteArray()
    }

    private fun randomToken(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }.let(::base64Url)

    private fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
