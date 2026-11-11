package ai.nekro.nxt

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Receives pairing links (`nekronxt://pair?…`) from the system camera or a browser and hands only the link to the
 * connect screen, which stays private: other apps cannot open it with text of their choosing.
 */
class PairLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        intent?.dataString?.let { link ->
            startActivity(
                Intent(this, ConnectActivity::class.java)
                    .putExtra(ConnectActivity.EXTRA_LINK, link)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
        finish()
    }
}
