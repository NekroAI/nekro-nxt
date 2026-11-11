package ai.nekro.nxt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class InstanceClientTest {
    @Test
    fun proofMatchesDesktop() {
        // Node: createHmac('sha256', key).update(lines.join('\n')).digest('base64url'), as apps/desktop computes it.
        val proof = InstanceClient.pairProof(
            "k".repeat(32) + "密钥",
            listOf("nxt-management-pair-v1", "cid", "snonce", "cnonce", "nxt_instance_01", "spki"),
        )
        assertEquals("16T3P12Qm5ZCqSwUimhwIxdZDRaOSmtJUcNsXixFhS8", proof)
    }

    @Test
    fun addressesBecomeOrigins() {
        assertEquals("https://nxt.example.com", InstanceClient.normalizeOrigin(" nxt.example.com/ "))
        assertEquals("https://192.168.1.5:4960", InstanceClient.normalizeOrigin("192.168.1.5:4960"))
        assertEquals("http://nxt.lan:8080", InstanceClient.normalizeOrigin("HTTP://NXT.lan:8080/chat?x=1"))
        assertThrows(InstanceError::class.java) { InstanceClient.normalizeOrigin("ftp://nxt.example.com") }
        assertThrows(InstanceError::class.java) { InstanceClient.normalizeOrigin("https://user@nxt.example.com") }
        assertThrows(InstanceError::class.java) { InstanceClient.normalizeOrigin("") }
    }

    @Test
    fun pairingLinksCarryOriginCodeAndKey() {
        val spki = "A".repeat(43)
        val link = PairingLink.parse("nekronxt://pair?origin=https%3A%2F%2Fnxt.example.com%3A4960&code=abcd-efgh&spki=$spki")
        assertEquals(PairingLink("https://nxt.example.com:4960", "ABCD-EFGH", spki), link)
        // A key that is not a fingerprint is dropped; the address is then checked on first use.
        assertEquals(null, PairingLink.parse("nekronxt://pair?origin=https%3A%2F%2Fa.example&code=ABCDEFGH&spki=x")?.spkiSha256)
        assertEquals(null, PairingLink.parse("https://nxt.example.com/login?code=ABCD-EFGH"))
        assertEquals(null, PairingLink.parse("nekronxt://pair?origin=ftp%3A%2F%2Fa&code=ABCD-EFGH"))
        assertEquals(null, PairingLink.parse("nekronxt://pair?origin=https%3A%2F%2Fa.example&code=ABCD-EFG1"))
    }

    @Test
    fun typedCredentialsAreCodesOrKeys() {
        assertEquals("ABCD-EFGH", InstanceClient.pairingCode(" abcd efgh "))
        // 0, 1, I, L and O are not in pairing codes, so a long key is never taken for one.
        assertEquals(null, InstanceClient.pairingCode("ABCD-EFG0"))
        assertEquals(null, InstanceClient.pairingCode("k".repeat(40)))
    }

    @Test
    fun updateManifestsResolveFilesNextToThem() {
        val manifest = org.json.JSONObject(
            """{"format":"nxt.android-mirror","version":1,"channel":"stable","versionName":"0.2.0","versionCode":2000,
            "file":{"name":"nekro-nxt-android-v0.2.0.apk","size":10,"sha256":"${"a".repeat(64)}",
            "path":"files/v0.2.0/nekro-nxt-android-v0.2.0.apk","githubUrl":"https://github.com/x/y.apk"}}""",
        )
        val release = Updater.parse(manifest, "https://dl.nekro.ai/nxt/android/stable/manifest.json")
        assertEquals("https://dl.nekro.ai/nxt/android/stable/files/v0.2.0/nekro-nxt-android-v0.2.0.apk", release.mirrorUrl)
        assertEquals(2000, release.versionCode)
    }
}
