package ai.nekro.nxt

import android.annotation.SuppressLint
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * TLS identity the same way Desktop pins it (apps/desktop/src/remote-pairing.ts): SHA-256 of the certificate's
 * SubjectPublicKeyInfo, base64url without padding. The value matches what the instance reports in its pairing
 * challenge, so the native requests and the WebView check one fingerprint.
 */
object Pins {
    fun spkiSha256(certificate: X509Certificate): String =
        Base64.getUrlEncoder().withoutPadding()
            .encodeToString(MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded))

    /** Groups of four for reading aloud or comparing with the instance's settings page. */
    fun display(spki: String): String = spki.chunked(4).joinToString(" ")

    private val systemTrust: X509TrustManager by lazy {
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(null as KeyStore?)
        factory.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    /** Whether the system's own certificate authorities accept this chain for a server. */
    fun systemTrusts(chain: Array<X509Certificate>): Boolean =
        try {
            systemTrust.checkServerTrusted(chain, "ECDHE_RSA")
            true
        } catch (_: CertificateException) {
            false
        } catch (_: IllegalArgumentException) {
            false
        }

    /**
     * Accepts exactly the pinned key, or, while inspecting a new address, any certificate so its chain can be read.
     * Never used for addresses the system already trusts.
     */
    @SuppressLint("CustomX509TrustManager")
    class PinningTrustManager(private val expected: String?) : X509TrustManager {
        @Volatile
        var observed: Array<X509Certificate>? = null
            private set

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
            throw CertificateException("Client certificates are not used.")

        @SuppressLint("TrustAllX509TrustManager")
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            observed = chain
            val leaf = chain.firstOrNull() ?: throw CertificateException("The server sent no certificate.")
            if (expected != null && spkiSha256(leaf) != expected) {
                throw CertificateException("The server's TLS identity changed.")
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    fun socketFactory(trust: X509TrustManager): SSLSocketFactory =
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }.socketFactory

    /** A pinned key is the identity; self-signed instances are often reached by IP, which no name in them matches. */
    val pinnedHostnames = HostnameVerifier { _, _ -> true }
}
