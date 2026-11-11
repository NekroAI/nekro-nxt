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
}
